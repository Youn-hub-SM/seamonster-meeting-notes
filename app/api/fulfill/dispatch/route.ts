import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { signedQty } from "@/app/lib/inventory";
import { getAllBundles, expandBundleQty } from "@/app/lib/product-bundles";
import { getUntracked, dropUntracked } from "@/app/lib/stock-tracked";
import { readStockMap } from "@/app/lib/inventory-template";
import { itemsSig } from "@/app/lib/fulfill-sig";
import { getDedupConfig } from "@/app/lib/fulfill-dedup";
import { INTERRUPT_MS, chunks, fetchSkuProducts, insertTxnsWithFallback, kstToday, maybeInterrupted, missingColumn, missingTable, stockFixesAfter, type StockFixHit } from "@/app/lib/fulfill-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Item = { sku: string; qty: number; orderDate?: string | null };
type ProductRow = { productId: string; name: string; option: string; need: number; current: number; after: number; short: boolean };
type ItemRow = { sku: string; name: string; qty: number; kind: "single" | "bundle" | "unmatched" | "ambiguous" | "untracked" };
type Unmatched = { sku: string; qty: number; kind: "unmatched" | "ambiguous" };

// 중복 검사 서명 — SKU별 '합산' 수량 기준(주문일 분해와 무관). generate 의 배치 서명과 같은 산식(itemsSig).
const sigOf = (items: Item[]): string => itemsSig(items);

// 주문일(L열 파싱값) 검증 — 메모 표시용. 형식 불량·미래·과도한 과거(14일 초과)는 버린다.
function validOrderDate(v: string | null | undefined, today: string): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  if (v > today) return null;
  const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 14);
  if (v < d.toISOString().slice(0, 10)) return null;
  return v;
}

// POST { items:[{sku,qty,orderDate?}], commit?, sig?, expectKeys?, force?, allowOverlap?, allowUnmatched?, ackDedupOff?, resumeInterrupted?, ackCount?, closeInterrupted? }
//  commit=false → 미리보기(재고 확인). commit=true → 소매 출고 일괄 기록.
//  sig = generate 가 준 배치 서명(batchSig). expectKeys = generate 가 대기 키를 저장했음(hasKeys).
//  확인이 필요한 경우 409 로 멈추고 이유 플래그를 준다 — 화면이 사람에게 묻고 해당 플래그를 켜서 다시 보낸다:
//   unmatched(재고가 안 빠지는 코드 → allowUnmatched) · dedupOff(중복 방지 꺼짐 → ackDedupOff) ·
//   duplicate(최근 같은 배치 → force) · interrupted(재고 기록 없는 앞선 출고 → resumeInterrupted 또는 closeInterrupted) ·
//   countAfter(그 앞선 출고 뒤 실사·직접 기록한 소매 출고가 있음 → ackCount 또는 closeInterrupted) ·
//   overlap(이미 다른 배치로 처리된 주문 → allowOverlap) · noPending(분석 기록 없음 → 다시 올리기).
//  closeInterrupted = 차감 없이 정리 — 재고를 이미 따로 맞춘 중단된 출고를 '재고 행 없이 처리완료된 배치'로 닫는다(3-2).
//  원장 날짜 = 출고를 누른 KST 날짜(S6 — 실물이 나간 처리일). 주문일은 메모에만 남긴다.
type PrevDispatch = { id: string; group_id: string | null; sku_count: number | null; created_at: string; order_no: string | null; dispatch_date: string };
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      items?: Item[]; commit?: boolean; sig?: string; expectKeys?: boolean;
      force?: boolean; allowOverlap?: boolean; allowUnmatched?: boolean; ackDedupOff?: boolean; resumeInterrupted?: boolean;
      ackCount?: boolean; closeInterrupted?: boolean;
    };
    const closeGhost = !!body.closeInterrupted;
    const today = kstToday();
    // 같은 SKU 가 주문일별로 여러 줄 와도 한 줄로 합친다(원장 날짜는 처리일 하나)
    const merged = new Map<string, Item>();
    const orderDates: string[] = [];
    for (const i of body.items || []) {
      if (!i || !i.sku || !(Number(i.qty) > 0)) continue;
      const sku = String(i.sku).trim();
      const k = sku.toUpperCase();
      const cur = merged.get(k) ?? { sku, qty: 0 };
      cur.qty = Math.round((cur.qty + Number(i.qty)) * 100) / 100;
      merged.set(k, cur);
      const od = validOrderDate(i.orderDate, today);
      if (od) orderDates.push(od);
    }
    const items = [...merged.values()];
    if (!items.length) return NextResponse.json({ ok: false, error: "출고할 품목이 없습니다." }, { status: 400 });
    const commit = !!body.commit;
    const sb = supabaseAdmin();

    // 상품 맵(대문자 SKU) + 묶음. spec = 옵션. 페이지 나눠 전량 — 잘리면 등록된 코드가 '미등록'으로 빠진다.
    const prods = await fetchSkuProducts<{ id: string; sku: string; name: string; spec?: string }>(sb, "id, sku, name, spec");
    const bySku = new Map<string, { id: string; name: string }[]>();
    const nameById = new Map<string, string>();
    const optById = new Map<string, string>();
    for (const p of prods) {
      const k = String(p.sku || "").trim().toUpperCase();
      nameById.set(p.id, p.name || "");
      optById.set(p.id, p.spec || "");
      if (!k) continue;
      const a = bySku.get(k) || []; a.push({ id: p.id, name: p.name || "" }); bySku.set(k, a);
    }
    const [bundles, untracked] = await Promise.all([getAllBundles(sb), getUntracked(sb)]);

    // 아이템 해석 + 묶음 전개 → product_id별 수량
    const perProduct = new Map<string, number>();
    const itemRows: ItemRow[] = [];
    for (const it of items) {
      const m = bySku.get(it.sku.toUpperCase());
      if (!m || !m.length) { itemRows.push({ sku: it.sku, name: "", qty: it.qty, kind: "unmatched" }); continue; }
      if (m.length > 1) { itemRows.push({ sku: it.sku, name: m[0].name, qty: it.qty, kind: "ambiguous" }); continue; }
      const p = m[0];
      const isBundle = (bundles.get(p.id)?.length || 0) > 0;
      expandBundleQty(bundles, p.id, it.qty, perProduct); // 공용 전개 규칙
      itemRows.push({ sku: it.sku, name: p.name, qty: it.qty, kind: isBundle ? "bundle" : untracked.ids.has(p.id) ? "untracked" : "single" });
    }
    // 재고가 빠지지 않는 코드(미등록·중복 SKU) — 실물은 CN 으로 나가므로 조용히 넘기지 않는다(S9).
    const unmatched: Unmatched[] = itemRows
      .filter((r): r is ItemRow & { kind: "unmatched" | "ambiguous" } => r.kind === "unmatched" || r.kind === "ambiguous")
      .map((r) => ({ sku: r.sku, qty: r.qty, kind: r.kind }));
    // '재고 관리 사용 안함'(121) 품목은 차감하지 않는다 — 구성품 단위로 뺀다(세트 안의 관리 대상 구성품은 계속 차감).
    const matchedAny = perProduct.size > 0; // 빼기 전 — 구성품이 전부 재고 관리 안 함인 세트도 '매칭됨'으로 센다
    dropUntracked(perProduct, untracked);

    const productIds = [...perProduct.keys()];
    // 재고 행 없이 커밋하는 배치 — 재고 관리 안 함뿐(untrackedOnly)이거나 전부 미등록(unmatchedOnly).
    //  차감할 재고는 없어도 '출고 완료'로 주문을 처리됨으로 표시해야 다음 날 누적 파일에서 다시 발주되지 않는다.
    const untrackedOnly = !productIds.length && matchedAny;
    const unmatchedOnly = !productIds.length && !matchedAny && unmatched.length > 0;

    // 현재 소매 재고(오늘 기준) — 공용 readStockMap(inventory_stock RPC 를 페이지 끝까지, S1·S4).
    //  단발 RPC 는 서버 Max Rows(1000)에 잘려 뒤쪽 품목이 '재고 0 → 부족'으로 보였다. 036 미적용(PGRST202)만 칸 없이 읽고
    //  그 밖의 오류는 멈춘다(재고를 모른 채 부족·차감 후 수량을 보여 주지 않는다).
    const stockMap = new Map<string, number>();
    if (productIds.length) {
      let all: Map<string, number>;
      try { all = await readStockMap(sb, { asof: today, chan: "소매" }); }
      catch (e) {
        return NextResponse.json({ ok: false, error: `재고를 읽지 못했습니다 — 다시 시도하세요. (${extractErrorMsg(e, "재고 조회 실패")})` }, { status: 500 });
      }
      for (const pid of productIds) { const q = all.get(pid); if (q != null) stockMap.set(pid, q); }
    }

    const productRows: ProductRow[] = productIds.map((pid) => {
      const need = perProduct.get(pid) || 0; const current = stockMap.get(pid) || 0;
      return { productId: pid, name: nameById.get(pid) || "", option: optById.get(pid) || "", need, current, after: current - need, short: current - need < 0 };
    }).sort((a, b) => a.name.localeCompare(b.name, "ko") || a.option.localeCompare(b.option, "ko")); // 가나다순
    const shortages = productRows.filter((r) => r.short).length;

    if (!commit) {
      return NextResponse.json({ ok: true, committed: false, items: itemRows, products: productRows, shortages, untrackedOnly, unmatchedOnly, unmatched,
        ...(untrackedOnly ? { message: "재고 관리 사용 안함 품목뿐이라 재고는 차감하지 않습니다. '출고 완료'를 누르면 주문만 처리됨으로 표시됩니다." } : {}),
        ...(unmatchedOnly ? { message: "상품마스터에 있는 품목이 없어 재고는 차감되지 않습니다." } : {}) });
    }
    if (!productIds.length && !untrackedOnly && !unmatchedOnly) {
      return NextResponse.json({ ok: true, committed: false, items: itemRows, products: [], shortages: 0, message: "매칭된(출고 가능) 품목이 없습니다." });
    }

    // ── 커밋 ──
    if (unmatched.length && !body.allowUnmatched) {
      const q = unmatched.reduce((s, u) => s + u.qty, 0);
      return NextResponse.json({ ok: false, unmatched, needUnmatchedAck: true,
        error: `상품마스터에 없는(또는 중복) 코드 ${unmatched.length}개 · ${q.toLocaleString()}개는 재고에서 빠지지 않습니다 — 등록 후 다시 확인하거나, 차감 없이 출고에 동의하세요.` }, { status: 409 });
    }
    const dedup = await getDedupConfig();
    if (!dedup.enabled && !body.ackDedupOff) {
      return NextResponse.json({ ok: false, dedupOff: true, error: "중복 방지가 꺼져 있습니다 — 이미 출고한 주문이 섞여 있어도 걸러지지 않고 다시 차감됩니다." }, { status: 409 });
    }
    const force = !!body.force;
    const sig = typeof body.sig === "string" && /^[0-9a-f]{16}$/i.test(body.sig) ? body.sig.toLowerCase() : sigOf(items);

    // 1) 같은 배치(같은 서명)의 앞선 출고 — 최근 7일에 정상 출고가 있으면 '이미 출고됨'. 지연·재작업으로 이튿날 같은 엑셀을
    //  다시 올리는 경우가 실제 이중출고 원인. 재출고는 force.
    //  재고 행이 하나도 없는 이력(2분 지남)은 '중단된 출고'(이력·키 기록 뒤 재고 기록 전에 끊김, 또는 옛 화면에서 재고만 취소)다 —
    //  '이미 출고됨'으로 막으면 사람이 [취소]를 눌러 재고가 영영 안 빠진다(S9·S12). 따로 묻고(interrupted), [확인]이면
    //  그 이력과 그 배치가 등록한 처리완료 키를 지운 뒤 이어서 차감한다. force 여도 본다 — 남은 키가 이번 출고를 '이미 처리된 주문'으로
    //  막고, 이번 묶음을 나중에 취소해도 그 키는 안 지워진다. 키 정리는 3)의 키 조회 전에 해야 이번 배치로 다시 등록된다.
    //  2분 안의 행은 다른 창의 진행 중 커밋일 수도, 방금 끊긴 커밋일 수도 있다 — 지우지도(양쪽 다 차감) '이미 출고됨'으로
    //  묻지도(취소하면 영영 미차감) 않고, 잠시 뒤 다시 누르게 한다(그때는 끝났거나 중단으로 판정된다).
    //  중단 판정은 품목 수(sku_count) > 0 인 이력만 — 한 줄 취소로 배치의 마지막 재고 행을 지우면 txn DELETE 가 sku_count 를 0 으로 둔다
    //  (주문은 처리완료로 남는 정정). 그 배치는 '재고 행 없는 처리완료 배치'라 여기서 live('이미 출고됨', 재출고는 force)로 간다.
    //  그 표식 전(옛 화면)에 비운 배치는 끊긴 출고와 구분할 수 없어 interrupted 로 묻는다 — 화면이 [취소] 뒤 '차감 없이 정리'(closeInterrupted)를
    //  따로 묻는다(따로 기록·실사로 이미 맞춘 배치를 다시 빼지 않고 닫는 길).
    //  '이미 출고됨'(live)은 최근 7일만, 중단 판정은 기간 제한 없이 본다. 발주엑셀 분석(generate)은 중단 배치를 날짜와 무관하게
    //  '이어서 차감'으로 안내하는데, 여기서 7일만 보면 8일째부터 그 배치 키가 겹침(409 '이미 다른 배치로 출고 완료')으로 막혀
    //  다시 올리기만 반복되고 재고가 영영 안 빠졌다. 서명(batchSig)에 주문 키 집합이 섞여 있어 같은 서명 = 같은 주문이라
    //  그 배치의 키·이력만 정리된다(다른 주문에 영향 없음). 기간이 길어진 만큼 그 사이 실사·직접 기록이 이 출고분을 이미 반영했을 수 있어
    //  이어서 차감 전에 확인한다(1-1).
    let resumed = 0;
    const ghosts: PrevDispatch[] = [];
    {
      const since7 = new Date(Date.now() + 9 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10);
      const PREV_MAX = 200;
      const { data: prevData, error: dupErr } = await sb.from("fulfill_dispatch").select("id, group_id, sku_count, created_at, order_no, dispatch_date")
        .eq("sig", sig).order("dispatch_date", { ascending: false }).order("created_at", { ascending: false }).limit(PREV_MAX);
      if (dupErr && !missingTable(dupErr)) return NextResponse.json({ ok: false, error: `출고 이력 확인에 실패했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${dupErr.message})` }, { status: 500 });
      // 상한에 닿으면 잘렸을 수 있다 — '없음'으로 보고 차감하지 않는다(S4). 같은 파일을 200번 출고한 경우뿐이다.
      if ((prevData ?? []).length >= PREV_MAX) return NextResponse.json({ ok: false, error: "같은 배치의 출고 이력이 너무 많아 확인하지 못했습니다 — 재고는 차감하지 않았습니다. 관리자에게 알려 주세요." }, { status: 500 });
      const live: PrevDispatch[] = [];
      let inFlight = false;
      for (const p of (prevData ?? []) as PrevDispatch[]) {
        if (p.group_id && Number(p.sku_count) > 0) {
          const { count, error: ce } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("group_id", p.group_id);
          if (ce) return NextResponse.json({ ok: false, error: `출고 이력 확인에 실패했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${ce.message})` }, { status: 500 });
          if ((count ?? 0) === 0) {
            if (Date.now() - Date.parse(String(p.created_at)) > INTERRUPT_MS) ghosts.push(p); else inFlight = true;
            continue;
          }
        }
        if (String(p.dispatch_date) >= since7) live.push(p); // 7일 지난 정상 출고는 '이미 출고됨'으로 묻지 않는다(종전과 같다)
      }
      if (inFlight) return NextResponse.json({ ok: false, inFlight: true, error: "같은 배치의 출고가 방금 시작됐는데 아직 재고 기록이 없습니다(다른 창에서 진행 중이거나 중간에 끊김) — 2분 뒤 [출고 완료]를 다시 누르세요." }, { status: 409 });
      // 차감 없이 정리를 골랐는데 정리할 중단된 출고가 없다(다른 창이 이미 이어서 차감·정리) — 일반 출고로 넘어가 차감하지 않는다
      if (closeGhost && !ghosts.length) return NextResponse.json({ ok: false, error: "정리할 중단된 출고가 없습니다(다른 창에서 이미 처리했을 수 있습니다) — 재고는 차감하지 않았습니다. 새로고침 후 확인하세요." }, { status: 409 });
      // 정리는 중단된 출고만 닫고 재고를 쓰지 않으므로 '이미 출고됨'과 무관하다
      if (live.length && !force && !closeGhost) {
        const d = live[0];
        return NextResponse.json({ ok: false, error: `이미 최근 출고된 발주입니다(${d.dispatch_date}, 출고번호 ${d.order_no || "-"}). 같은 배치가 다시 출고되려 합니다.`, duplicate: true }, { status: 409 });
      }
      if (ghosts.length && !body.resumeInterrupted && !closeGhost) return interruptedResp(ghosts);
    }

    // 2) 이 파일의 대기 키(079) — 읽기 실패면 멈춘다(차감만 되고 '처리됨' 표시가 빠지면 다음 누적 파일에 다시 실린다).
    let pend: { keys: string[]; matchKeys: string[] | null } | null = null;
    let keysTable = true;
    {
      const strs = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((k): k is string => typeof k === "string" && !!k) : []);
      let r = await sb.from("fulfill_pending_keys").select("keys, match_keys").eq("sig", sig).maybeSingle();
      if (r.error && missingColumn(r.error, /match_keys/i)) r = await sb.from("fulfill_pending_keys").select("keys").eq("sig", sig).maybeSingle(); // 135 미적용
      if (r.error) {
        if (missingTable(r.error)) keysTable = false;
        else return NextResponse.json({ ok: false, error: `분석 기록을 읽지 못했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${r.error.message})` }, { status: 500 });
      } else if (r.data) {
        const d = r.data as { keys?: unknown; match_keys?: unknown };
        pend = { keys: strs(d.keys), matchKeys: Array.isArray(d.match_keys) ? strs(d.match_keys) : null };
      }
    }
    // 중단 배치를 이어받을 때는 force 여도 분석 기록이 있어야 한다 — 그 배치 키를 지운 뒤 다시 등록할 키가 없으면 실물은 나간 주문이
    //  '처리됨' 표시 없이 남아 다음 누적 파일에 다시 실린다.
    if (body.expectKeys && !pend && keysTable && (!force || ghosts.length)) {
      return NextResponse.json({ ok: false, noPending: true, error: "이 파일의 분석 기록이 없어 주문을 '처리됨'으로 표시할 수 없습니다(다른 창에서 이미 출고했을 수 있습니다) — 발주엑셀을 다시 올려 주세요." }, { status: 409 });
    }

    // 1-1) 이어서 차감 전 — 중단된 출고 뒤 그 품목의 소매 재고를 따로 맞춘 기록(실사 조정 · [입고 및 출고]에서 직접 기록한 소매 출고).
    //  실물은 중단된 출고일에 나갔다. 그 뒤 실사가 이미 반영했거나(센 수량에 빠진 게 들어 있음), 원장 점검 안내대로 직접 기록했으면
    //  오늘 날짜로 이어서 빼는 것이 두 번째 차감이다 — [재고 차감 기록](unmatched 라우트 countAfter)과 같은 공용 규칙(stockFixesAfter).
    //  기준 = 가장 오래된 중단 이력의 출고일·기록 시각. 사람이 '반영 안 됨'을 확인하면 ackCount, 이미 반영됐으면 closeInterrupted.
    //  조회 실패면 멈춘다(S4). 아무것도 쓰기 전이라 되돌릴 것이 없다.
    if (ghosts.length && !closeGhost && !body.ackCount && productIds.length) {
      const sinceDate = ghosts.map((g) => String(g.dispatch_date).slice(0, 10)).sort()[0];
      const sinceIso = ghosts.map((g) => new Date(String(g.created_at)).toISOString()).sort()[0];
      let found: StockFixHit[];
      try { found = await stockFixesAfter(sb, productIds, sinceDate, sinceIso, { manualOut: true }); }
      catch (e) { return NextResponse.json({ ok: false, error: `실사·직접 기록 확인에 실패했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${extractErrorMsg(e, "조회 실패")})` }, { status: 500 }); }
      if (found.length) {
        const part = (k: StockFixHit["kind"]) => {
          const l = found.filter((h) => h.kind === k);
          return l.length ? `${k} ${l.slice(0, 5).map((h) => `${h.name}(${h.date})`).join(", ")}${l.length > 5 ? ` 외 ${l.length - 5}개` : ""}` : "";
        };
        const detail = [part("실사"), part("직접 출고")].filter(Boolean).join(" · ");
        return NextResponse.json({ ok: false, countAfter: true, products: found,
          error: `중단된 출고(${sinceDate}) 뒤 이 품목의 재고를 따로 맞춘 기록이 있습니다 — ${detail}. 그 기록에 이 출고분이 이미 반영됐으면 이어서 차감하면 두 번 빠집니다.` }, { status: 409 });
      }
    }

    // 1-2) 중단된 출고 정리 — 분석 기록을 읽은 뒤(위에서 멈추면 아무것도 지우지 않는다), 3)의 키 조회 전에(이번 배치로 다시 등록되게).
    //  차감 없이 정리(closeGhost)는 이력·키를 지우지 않고 그대로 닫는다(3-2).
    for (const g of closeGhost ? [] : ghosts) {
      const fail = await clearInterrupted(sb, g);
      if (fail) return NextResponse.json({ ok: false, error: `중단된 출고 기록을 정리하지 못했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${fail})` }, { status: 500 });
      resumed++;
    }

    // 3) 커밋 시점 재확인 — 분석 뒤 다른 배치(다른 탭·담당자)가 같은 주문을 먼저 출고했을 수 있다(S2).
    //  판정은 현재 기준 키(match_keys, 135)로만 — 주문번호만 키까지 보면 구성이 바뀐 정당한 새 주문도 겹침으로 잡힌다.
    const sinceMs = Date.now() - dedup.windowDays * 86400e3;
    const existing = new Map<string, number>(); // key → processed_at(ms)
    const allKeys = pend ? [...new Set([...pend.keys, ...(pend.matchKeys ?? [])])] : [];
    for (const part of chunks(allKeys, 150)) {
      const { data, error } = await sb.from("fulfill_order_keys").select("key, processed_at").in("key", part);
      if (error) return NextResponse.json({ ok: false, error: `이미 처리된 주문 확인에 실패했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${error.message})` }, { status: 500 });
      for (const r of data ?? []) existing.set(r.key as string, Date.parse(String(r.processed_at)) || 0);
    }
    const isFresh = (k: string) => (existing.get(k) ?? -1) >= sinceMs;

    // 3-2) 차감 없이 정리(closeInterrupted) — 그 사이 직접 기록·실사로 재고를 이미 맞춘 중단된 출고를 닫는다. 재고 행은 쓰지 않는다.
    //  이력 행의 품목 수를 0 으로 = '재고 행 없이 처리완료된 배치'(재고 관리 안 함뿐인 배치·한 줄 취소로 비운 배치와 같은 상태,
    //  inventory/txn 라우트). 중단 판정(maybeInterrupted · 132 fulfill_interrupted)은 sku_count > 0 만 봐서 원장 점검·① 목록·분석의
    //  '이어서 차감' 안내에서 빠지고, 같은 파일을 다시 올리면 '이미 출고됨'(재출고는 force)으로 묻는다.
    //  겹침 확인은 하지 않는다(차감이 없어 이중 차감이 없다). 순서: 선점(품목 수 0, 조건부 — 다른 창이 먼저 이어서 차감·정리했으면 0건)
    //  → 처리완료 키(빠진 키 등록·창 밖 키 시각 갱신 — 그 주문이 다음 누적 파일에 다시 실리지 않게) → 대기 키 삭제.
    //  키 등록이 실패하면 품목 수를 되돌린다(닫혔는데 주문이 '처리됨'이 아니면 다시 발송·차감된다).
    if (closeGhost) {
      const { data: claimed, error: cle } = await sb.from("fulfill_dispatch").update({ sku_count: 0 }).in("id", ghosts.map((g) => g.id)).gt("sku_count", 0).select("id");
      if (cle) return NextResponse.json({ ok: false, error: `중단된 출고를 정리하지 못했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${cle.message})` }, { status: 500 });
      const got = new Set((claimed ?? []).map((r) => String(r.id)));
      if (!got.size) return NextResponse.json({ ok: false, error: "이 중단된 출고는 방금 다른 창에서 처리됐습니다 — 재고는 차감하지 않았습니다. 새로고침 후 확인하세요." }, { status: 409 });
      const owner = ghosts.find((g) => got.has(g.id))!; // ghosts = 출고일·기록 시각 내림차순 → 가장 최근 이력이 키 주인
      const undo = async () => {
        for (const g of ghosts) if (got.has(g.id)) { try { await sb.from("fulfill_dispatch").update({ sku_count: g.sku_count }).eq("id", g.id).eq("sku_count", 0); } catch { /* 최선 노력 */ } }
      };
      if (pend) {
        let withGroup = true;
        const nowIso = new Date().toISOString();
        const newKeys = allKeys.filter((k) => !existing.has(k));
        if (newKeys.length) {
          const mk = () => newKeys.map((key) => ({ key, order_no: owner.order_no || null, processed_at: nowIso, ...(withGroup ? { group_id: owner.group_id } : {}) }));
          let up = await sb.from("fulfill_order_keys").upsert(mk(), { onConflict: "key", ignoreDuplicates: true });
          if (up.error && missingColumn(up.error, /group_id/i)) { withGroup = false; up = await sb.from("fulfill_order_keys").upsert(mk(), { onConflict: "key", ignoreDuplicates: true }); }
          if (up.error) {
            await undo();
            return NextResponse.json({ ok: false, error: `처리완료 주문 등록에 실패했습니다 — 정리하지 않았습니다(재고 차감 없음). 다시 시도하세요. (${up.error.message})` }, { status: 500 });
          }
        }
        const stale = allKeys.filter((k) => existing.has(k) && !isFresh(k));
        for (const part of chunks(stale, 150)) {
          try {
            const touch = () => sb.from("fulfill_order_keys").update({ processed_at: nowIso, order_no: owner.order_no || null, ...(withGroup ? { group_id: owner.group_id } : {}) }).in("key", part).lt("processed_at", new Date(sinceMs).toISOString());
            const { error: te } = await touch();
            if (te && withGroup && missingColumn(te, /group_id/i)) { withGroup = false; await touch(); } // 135 미적용
          } catch { /* 최선 노력 */ }
        }
        try { await sb.from("fulfill_pending_keys").delete().eq("sig", sig); } catch { /* 남아도 미출고 목록에서 출고 이력으로 걸러진다 */ }
      }
      return NextResponse.json({ ok: true, committed: true, closed: got.size, already: false, resumed: 0, orderNo: owner.order_no || "", groupId: owner.group_id,
        items: itemRows, products: [], dispatched: 0, totalQty: 0, shortages: 0, unmatched: [], unmatchedSaved: false });
    }

    const checkOverlap = dedup.enabled && !!pend?.matchKeys?.length && !body.allowOverlap;
    const overlapMsg = (n: number) => `이미 다른 배치로 출고 완료된 주문 ${n}건이 이 파일에 섞여 있습니다.`;
    if (checkOverlap) {
      const n = pend!.matchKeys!.filter(isFresh).length;
      if (n) return NextResponse.json({ ok: false, overlap: n, error: overlapMsg(n) }, { status: 409 });
    }

    let orderNo = "";
    { const { data } = await sb.rpc("next_inventory_order_no", { p_type: "출고" }); orderNo = String(data || ""); } // 033 미적용이면 번호 없음
    let groupId: string = crypto.randomUUID();
    const totalQty = productRows.reduce((s, r) => s + r.need, 0);

    // 4) 출고 이력(fulfill_dispatch)을 재고 차감보다 '먼저' — 유니크(sig, dispatch_date, 111)가 동시 커밋의 이중 차감을 막는다.
    //  23505 외 오류로 기록을 건너뛰면 그 배치는 유일한 DB 중복 차단 없이 차감된다 → 표 없음(065 미적용)만 생략하고 멈춘다.
    //  keys(135) = 이 배치가 출고한 주문 키(두 산식, 겹침 허용으로 다른 배치가 먼저 등록한 키 포함) — 배치를 취소할 때
    //  cancel_fulfill_dispatch 가 다른 배치도 출고한 주문의 처리완료 키를 지우지 않고 그 배치로 넘기는 근거다.
    let dispatchRecorded = false;
    let unmatchedSaved = unmatched.length > 0;
    let unmatchedNotSaved: "no_column" | "no_table" | "same_day_force" | null = null; // 목록을 못 남긴 이유 — 화면 안내용
    let keysSaved = allKeys.length > 0;
    const dRow = () => ({ sig, dispatch_date: today, channel: "소매", sku_count: productIds.length, total_qty: totalQty, group_id: groupId, order_no: orderNo || null, created_by: "온라인발주",
      ...(unmatchedSaved ? { unmatched } : {}), ...(keysSaved ? { keys: allKeys } : {}) });
    const insertDispatch = async () => {
      let r = await sb.from("fulfill_dispatch").insert(dRow());
      for (let i = 0; i < 2 && r.error; i++) { // 135 미적용 — 없는 칸만 빼고 다시
        if (unmatchedSaved && missingColumn(r.error, /unmatched/i)) { unmatchedSaved = false; unmatchedNotSaved = "no_column"; }
        else if (keysSaved && missingColumn(r.error, /\bkeys\b/i)) keysSaved = false;
        else break;
        r = await sb.from("fulfill_dispatch").insert(dRow());
      }
      return r;
    };
    const dIns = await insertDispatch();
    if (dIns.error?.code === "23505") {
      // 같은 날 이력이 이미 있다. 그 행이 '중단된 출고'(2분 지남·재고 행 0)면 1)로 돌려보낸다 — 정리(키 포함)는 1)에서만 한다.
      //  여기서 지우면 3)이 그 키를 '이미 있음'으로 읽은 뒤라 이번 배치로 다시 등록되지 않는다. 그 사이 생긴 행만 이 경로에 온다.
      const { data: dupRow, error: de } = await sb.from("fulfill_dispatch").select("id, group_id, sku_count, created_at, order_no, dispatch_date").eq("sig", sig).eq("dispatch_date", today).maybeSingle();
      if (de) return NextResponse.json({ ok: false, error: `출고 이력 확인에 실패했습니다 — 재고는 차감하지 않았습니다. (${de.message})` }, { status: 500 });
      let ghost = false;
      if (dupRow && maybeInterrupted(dupRow)) {
        const { count, error: ce } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("group_id", dupRow.group_id!);
        if (ce) return NextResponse.json({ ok: false, error: `출고 이력 확인에 실패했습니다 — 재고는 차감하지 않았습니다. (${ce.message})` }, { status: 500 });
        ghost = (count ?? 0) === 0;
      }
      if (dupRow && ghost) return interruptedResp([dupRow as PrevDispatch]);
      if (!force) return NextResponse.json({ ok: false, error: "같은 배치가 방금 다른 창(또는 다른 사용자)에서 먼저 출고되었습니다 — 재고는 한 번만 차감됐습니다.", duplicate: true }, { status: 409 });
      // force 재출고: 같은 날 기록은 기존 행 유지, 재고 차감만 진행. 이 배치의 미반영 목록은 남길 행이 없다(135 적용과 무관).
      if (unmatchedSaved) unmatchedNotSaved = "same_day_force";
      unmatchedSaved = false;
    } else if (dIns.error) {
      if (!missingTable(dIns.error)) return NextResponse.json({ ok: false, error: `출고 이력 기록에 실패했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${dIns.error.message})` }, { status: 500 });
      if (unmatchedSaved) unmatchedNotSaved = "no_table";
      unmatchedSaved = false; // 065 미적용 — 기록 생략
    } else dispatchRecorded = true;

    // 보상 — 이번 요청이 넣은 키·이력을 되물린다(다음 시도가 겹침·중복에 막히지 않게, S3)
    let insertedKeys: string[] = [];
    let keyGroupCol = true;
    const compensate = async () => {
      for (const part of chunks(insertedKeys, 150)) { try { await sb.from("fulfill_order_keys").delete().in("key", part); } catch { /* 최선 노력 */ } }
      if (dispatchRecorded) { try { await sb.from("fulfill_dispatch").delete().eq("group_id", groupId); } catch { /* 최선 노력 */ } }
    };

    // 5) 처리완료 주문 키 등록(079) — 재고 차감 전에. 실패하면 차감하지 않는다.
    //  이미 있는 키는 그대로(ignoreDuplicates — 먼저 처리한 배치 소유 유지). 창 밖으로 오래된 키는 차감 뒤 시각만 갱신(7).
    if (pend && pend.keys.length) {
      const nowIso = new Date().toISOString();
      const newKeys = allKeys.filter((k) => !existing.has(k));
      if (newKeys.length) {
        const mk = (withGroup: boolean) => newKeys.map((key) => ({ key, order_no: orderNo || null, processed_at: nowIso, ...(withGroup ? { group_id: groupId } : {}) }));
        let up = await sb.from("fulfill_order_keys").upsert(mk(true), { onConflict: "key", ignoreDuplicates: true }).select("key");
        if (up.error && missingColumn(up.error, /group_id/i)) { keyGroupCol = false; up = await sb.from("fulfill_order_keys").upsert(mk(false), { onConflict: "key", ignoreDuplicates: true }).select("key"); }
        if (up.error) {
          await compensate();
          return NextResponse.json({ ok: false, error: `처리완료 주문 등록에 실패했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${up.error.message})` }, { status: 500 });
        }
        insertedKeys = (up.data ?? []).map((r) => r.key as string);
      }
      // 경합: 3)의 확인 뒤 다른 커밋이 같은 주문 키를 먼저 넣었으면(우리 insert 가 무시됨) 겹침
      if (checkOverlap) {
        const ins = new Set(insertedKeys);
        const raced = pend.matchKeys!.filter((k) => !existing.has(k) && !ins.has(k)).length;
        if (raced) { await compensate(); return NextResponse.json({ ok: false, overlap: raced, error: overlapMsg(raced) }, { status: 409 }); }
      }
    }

    // 6) 재고 행 — 원장 날짜 = 처리일(오늘 KST). request_key(131)로 같은 배치 재시도의 이중 기록을 DB 가 막는다.
    const od = [...new Set(orderDates)].sort();
    const memo = `온라인발주 출고 ${today}${od.length ? ` (주문일 ${od[0]}${od.length > 1 ? `~${od[od.length - 1]}` : ""})` : ""}`;
    const rows: Record<string, unknown>[] = [];
    for (const [pid, q] of perProduct) {
      if (q <= 0) continue;
      rows.push({ product_id: pid, type: "출고", qty: signedQty("출고", q), channel: "소매", status: "완료", group_id: groupId, order_no: orderNo || null, partner: "온라인몰", memo, txn_date: today,
        request_key: force ? `fulfill:${groupId}:${pid}` : `fulfill:${sig}:${today}:${pid}`, source: "fulfill", source_ref: sig });
    }
    let already = false;
    const { error: insErr } = await insertTxnsWithFallback(sb, rows);
    if (insErr && insErr.code === "23505" && !force) {
      // 같은 배치의 재고 행이 이미 있다(앞 시도가 기록 후 응답만 잃음) — 그 묶음을 이 출고로 이어 붙이고 성공으로 본다.
      const { data: prev } = await sb.from("inventory_txns").select("group_id, order_no").eq("request_key", rows[0].request_key as string).maybeSingle();
      if (!prev?.group_id) {
        await compensate();
        return NextResponse.json({ ok: false, error: "같은 배치의 재고 기록이 이미 있습니다 — 새로고침 후 [입고 및 출고]에서 확인하세요.", duplicate: true }, { status: 409 });
      }
      already = true;
      const oldGroup = groupId;
      groupId = String(prev.group_id); orderNo = String(prev.order_no || orderNo || "");
      if (dispatchRecorded) await sb.from("fulfill_dispatch").update({ group_id: groupId, order_no: orderNo || null }).eq("group_id", oldGroup);
      if (insertedKeys.length && keyGroupCol) for (const part of chunks(insertedKeys, 150)) await sb.from("fulfill_order_keys").update({ group_id: groupId, order_no: orderNo || null }).in("key", part);
    } else if (insErr) {
      await compensate();
      return NextResponse.json({ ok: false, error: `재고 기록에 실패했습니다 — 다시 시도하세요. (${insErr.message})` }, { status: 500 });
    }

    // 7) 창 밖으로 오래된 키는 이번 처리 시각으로 갱신 — 그래야 다음 누적 파일에서 다시 걸러진다. 실패해도 차감은 유지.
    if (pend) {
      const stale = allKeys.filter((k) => existing.has(k) && !isFresh(k));
      for (const part of chunks(stale, 150)) {
        try {
          await sb.from("fulfill_order_keys").update({ processed_at: new Date().toISOString(), order_no: orderNo || null, ...(keyGroupCol ? { group_id: groupId } : {}) }).in("key", part).lt("processed_at", new Date(sinceMs).toISOString());
        } catch { /* 최선 노력 */ }
      }
      try { await sb.from("fulfill_pending_keys").delete().eq("sig", sig); } catch { /* 남아도 미출고 목록에서 출고 이력으로 걸러진다 */ }
    }

    return NextResponse.json({ ok: true, committed: true, already, resumed, orderNo, groupId, items: itemRows, products: productRows, dispatched: productIds.length, totalQty, shortages, unmatched, unmatchedSaved,
      ...(unmatched.length && !unmatchedSaved ? { unmatchedNotSaved: unmatchedNotSaved ?? "no_column" } : {}) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "출고 실패") }, { status: 500 });
  }
}

// 재고 기록 없는 앞선 출고 — '이미 출고됨'(duplicate)·재출고(force)와 다른 질문이다: 재고가 아직 안 빠졌다.
function interruptedResp(ghosts: PrevDispatch[]) {
  const list = ghosts.slice(0, 3).map((g) => `${g.dispatch_date}${g.order_no ? ` ${g.order_no}` : ""}`).join(", ") + (ghosts.length > 3 ? ` 외 ${ghosts.length - 3}건` : "");
  return NextResponse.json({ ok: false, interrupted: ghosts.length,
    error: `앞선 출고(${list})의 재고 기록이 없습니다 — 중간에 끊겼거나 재고만 취소된 출고입니다. 그 사이 재고를 따로 기록했거나 실사로 맞춘 배치면 이어서 차감하지 마세요(두 번 빠집니다).` }, { status: 409 });
}

// 중단된 출고 정리 — 그 배치가 등록한 처리완료 키 + 출고 이력 행. 키 찾는 규칙은 cancel_fulfill_dispatch(135)와 같다:
//  group_id 로, 135 전 키(group_id 비어 있음)는 출고번호로. 취소와 달리 다른 배치로 넘기지 않고 지운다 — 같은 서명 = 같은 주문 키
//  집합이라 이어서 차감하는 이번 배치가 5)에서 그 키를 전부 다시 등록한다. 실패하면 오류 문구, 성공이면 null.
async function clearInterrupted(sb: ReturnType<typeof supabaseAdmin>, g: PrevDispatch): Promise<string | null> {
  const keys = () => sb.from("fulfill_order_keys").delete();
  const { error: ke } = await keys().eq("group_id", g.group_id!);
  let err = ke;
  if (ke && missingTable(ke)) err = null; // 079 미적용 — 키 없음
  else if (ke && missingColumn(ke, /group_id/i)) err = g.order_no ? (await keys().eq("order_no", g.order_no)).error : null; // 135 미적용 — 출고번호로만
  else if (!ke && g.order_no) err = (await keys().is("group_id", null).eq("order_no", g.order_no)).error;
  if (err) return err.message;
  // 그 이력에 [재고 차감 기록]으로 넣은 늦은 출고(131 source_ref = 이력 id)도 — 이번 출고가 지금 상품마스터로 전부 다시 계산해
  //  차감하므로 남기면 그 코드가 두 번 빠진다. 131 미적용이면 그런 행이 없다(unmatched 라우트가 기록을 막음).
  const { error: le } = await sb.from("inventory_txns").delete().eq("source", "fulfill_unmatched").eq("source_ref", g.id);
  if (le && !missingColumn(le, /source/i)) return le.message;
  const { error: de } = await sb.from("fulfill_dispatch").delete().eq("id", g.id);
  return de ? de.message : null;
}
