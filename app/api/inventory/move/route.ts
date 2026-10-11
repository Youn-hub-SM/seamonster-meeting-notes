import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logInventoryMovedToWholesale, logInventoryPoolMoved } from "@/app/lib/b2b-activity";
import { validateManualAllocations, applyManualAllocations, recheckRequestCompletion, getRequestFullness, type ManualAlloc, type AllocPurpose } from "@/app/lib/production-allocate";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { toInvChannelParam, MOVE_ONLY_CHANNELS, RESERVED_CHANNELS } from "@/app/lib/inventory";
import { PR_PURPOSES, PURPOSE_CHANNEL } from "@/app/lib/wholesale-production";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";
import { getUntracked } from "@/app/lib/stock-tracked";
import { kstTodayIso } from "@/app/lib/production-schedule";
import { isDupRequestKey, isMissing131, loadByRequestKey, parseRequestKey, REQUEST_KEY_CONFLICT_MSG } from "../txn/ledger-write";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 줄마다 기록·배정·알림을 기다린다 — 기본 제한에 끊기면 화면엔 실패로 보이고 다시 눌린다

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARK = "채널이동"; // partner 필드에 마커로 넣어 이동 내역을 구분·조회

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// 프로모션 → 소매 이동이 열린 프로모션 요청서(요청·진행중) 몫을 건드리는 품목(#5).
//  몫 = (요청서, 품목)별 이행 순합(배정 + 마감 합류의 음수 연결, 0 미만은 0) — promotion-close 의 '남길 몫'과 같은 규칙.
//  옛 합류(음수 연결 없음)의 백필은 여기서 하지 않는다 — 몫이 크게 잡혀 확인을 한 번 더 묻는 쪽으로만 틀린다(쓰기 경로가 아니라서).
//  옮길 수 있는 풀 = min(전체, 오늘까지) 프로모션 재고(마감 합류와 같은 기준). 이동 수량이 (풀 − 몫)을 넘는 품목만 돌려준다.
//  조회 실패는 null — 호출부는 옮기지 않는다(S4). 082(purpose) 미적용이면 프로모션 요청서가 없다.
//  free = 몫 밖이라 확인 없이 옮길 수 있는 수량(수량을 이만큼으로 줄이면 409 없이 옮겨진다).
type ReservedHit = { product_id: string; qty: number; reserved: number; free: number; req_nos: string[] };
async function promoReservedHits(
  sb: ReturnType<typeof supabaseAdmin>, items: { product_id: string; qty: number }[], today: string,
): Promise<ReservedHit[] | null> {
  const pids = [...new Set(items.map((it) => it.product_id))];
  type Head = { req_no?: string | null };
  type Line = { id: string; product_id: string; request_id: string; production_requests?: Head | Head[] | null };
  const lines: Line[] = [];
  for (let i = 0; i < pids.length; i += 100) {
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("production_request_items")
        .select("id, product_id, request_id, production_requests!inner(purpose, status, req_no)")
        .in("product_id", pids.slice(i, i + 100))
        .eq("production_requests.purpose", "프로모션").in("production_requests.status", ["요청", "진행중"])
        .order("id", { ascending: true }).range(off, off + 999);
      if (error) return /purpose/i.test(error.message) ? [] : null;
      lines.push(...((data ?? []) as unknown as Line[]));
      if ((data ?? []).length < 1000) break;
    }
  }
  if (!lines.length) return [];
  const lineOf = new Map(lines.map((l) => [String(l.id), l]));
  const reqNo = new Map(lines.map((l) => {
    const h = Array.isArray(l.production_requests) ? l.production_requests[0] : l.production_requests;
    return [String(l.request_id), String(h?.req_no ?? "")];
  }));
  const net = new Map<string, number>(); // `${요청서}|${품목}` → 이행 순합
  const ids = [...lineOf.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("production_receipts").select("item_id, qty")
        .in("item_id", ids.slice(i, i + 100)).order("id", { ascending: true }).range(off, off + 999);
      if (error) return null;
      for (const rc of data ?? []) {
        const l = lineOf.get(String(rc.item_id));
        if (!l) continue;
        const k = `${l.request_id}|${l.product_id}`;
        net.set(k, (net.get(k) || 0) + (Number(rc.qty) || 0));
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const reserved = new Map<string, number>();
  const reqsOf = new Map<string, Set<string>>();
  for (const [k, q] of net) {
    const v = Math.round(q * 100) / 100;
    if (v <= 0) continue;
    const [rid, pid] = k.split("|");
    reserved.set(pid, (reserved.get(pid) || 0) + v);
    const s = reqsOf.get(pid) ?? new Set<string>();
    const no = reqNo.get(rid);
    if (no) s.add(no);
    reqsOf.set(pid, s);
  }
  const held = pids.filter((p) => (reserved.get(p) || 0) > 0);
  if (!held.length) return [];
  const [all, upto] = await Promise.all([
    sb.rpc("inventory_stock", { asof: null, chan: "프로모션" }).in("product_id", held),
    sb.rpc("inventory_stock", { asof: today, chan: "프로모션" }).in("product_id", held),
  ]);
  if (all.error || upto.error) return null;
  const qm = (d: unknown) => new Map(((d as { product_id: string; qty: unknown }[] | null) ?? []).map((r) => [String(r.product_id), Number(r.qty)]));
  const am = qm(all.data), tm = qm(upto.data);
  const out: ReservedHit[] = [];
  for (const it of items) {
    const res = reserved.get(it.product_id) || 0;
    if (res <= 0) continue;
    const a = am.get(it.product_id) ?? 0, t = tm.get(it.product_id) ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(t)) return null;
    const free = Math.max(0, Math.min(a, t) - res); // 몫 밖의 '기타' 확보분 — 이만큼은 확인 없이 옮긴다
    if (it.qty <= free + 0.001) continue;
    out.push({
      product_id: it.product_id,
      qty: Math.round(Math.min(res, it.qty - free) * 100) / 100,
      reserved: Math.round(res * 100) / 100,
      free: Math.floor(free * 100) / 100, // 내림 — 올림하면 그 수량으로 다시 보내도 0.001 허용치를 넘어 또 409 가 난다
      req_nos: [...(reqsOf.get(it.product_id) ?? [])],
    });
  }
  return out;
}

// GET ?limit= — 최근 옮긴 내역(그룹 단위)
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("inventory_txns")
      .select("id, product_id, type, qty, channel, txn_date, memo, group_id, created_at, created_by, products:product_id(name, sku)")
      .eq("partner", MARK)
      .order("created_at", { ascending: false })
      .limit(limit * 2); // 이동 1건 = 출고+입고 2행
    if (error) throw error;

    // group_id 로 짝지어 이동 1건으로 합침
    type Leg = { id: string; product_id: string; type: string; qty: number; channel: string; txn_date: string; memo: string | null; group_id: string | null; created_at: string; created_by: string | null; products: { name?: string; sku?: string | null } | { name?: string; sku?: string | null }[] | null };
    const byGroup = new Map<string, Leg[]>();
    for (const r of (data as unknown as Leg[]) ?? []) {
      const k = r.group_id || r.id;
      byGroup.set(k, [...(byGroup.get(k) || []), r]);
    }
    const moves = [...byGroup.entries()].map(([group_id, legs]) => {
      const out = legs.find((l) => l.type === "출고");
      const inn = legs.find((l) => l.type === "입고");
      const p = (inn || out)?.products;
      const prod = Array.isArray(p) ? p[0] : p;
      return {
        group_id,
        in_id: inn?.id || null, // 배정 요약 조회용(응답 전 제거)
        product_name: prod?.name || "(품목?)",
        sku: prod?.sku || null,
        qty: Math.abs(Number((inn || out)?.qty) || 0),
        from: out?.channel || "?",
        to: inn?.channel || "?",
        txn_date: (inn || out)?.txn_date || "",
        memo: (inn || out)?.memo || null,
        created_at: (inn || out)?.created_at || "",
        created_by: (inn || out)?.created_by || null,
        complete: !!(out && inn),
        alloc_qty: 0,
        alloc_reqs: [] as string[],
      };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);

    // 배정 요약 — 이동의 도매 입고편에 연결된 요청서 배정(수량 합 + 요청번호). 실패해도 목록은 낸다.
    try {
      const inIds = moves.map((m) => m.in_id).filter((v): v is string => !!v);
      if (inIds.length) {
        const { data: rcs } = await sb.from("production_receipts")
          .select("inv_txn_id, qty, request_id").in("inv_txn_id", inIds).limit(5000);
        const reqIds = [...new Set((rcs ?? []).map((r) => r.request_id as string).filter(Boolean))];
        const noById = new Map<string, string>();
        if (reqIds.length) {
          const { data: heads } = await sb.from("production_requests").select("id, req_no").in("id", reqIds);
          for (const h of heads ?? []) noById.set(h.id as string, (h.req_no as string) || "");
        }
        const byTxn = new Map<string, { qty: number; reqs: Set<string> }>();
        for (const r of rcs ?? []) {
          const k = r.inv_txn_id as string;
          const cur = byTxn.get(k) || { qty: 0, reqs: new Set<string>() };
          cur.qty += Number(r.qty) || 0;
          const no = noById.get(r.request_id as string);
          if (no) cur.reqs.add(no);
          byTxn.set(k, cur);
        }
        for (const m of moves) {
          const s = m.in_id ? byTxn.get(m.in_id) : undefined;
          if (s) { m.alloc_qty = Math.round(s.qty * 100) / 100; m.alloc_reqs = [...s.reqs]; }
        }
      }
    } catch { /* 요약 없이 진행 */ }

    return NextResponse.json({ ok: true, moves: moves.map(({ in_id: _drop, ...m }) => m) });
  } catch (err) {
    console.error("[inventory/move GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST — 품목 이동. 신형 { from, to, txn_date?, memo?, items:[{product_id, qty, allocations?}] } (여러 품목,
//  2026-09-16 대표 요청) 또는 구형 { product_id, from, to, qty, ... } (단일 — 배포 전 탭 호환).
//  품목마다 출고(−)+입고(+) 두 행을 '자기 group_id' 로 기록 — 줄 단위로 따로 취소할 수 있고
//  내역(GET)의 group 병합도 그대로 동작한다. 알림은 한 번의 이동 = 한 게시물로 묶는다.
//  request_key(131): 화면이 제출마다 만든 키. 줄의 두 편에 '<키>:<품목>:out|in' 을 넣어, 응답이 끊긴 뒤 다시 눌러도
//  이미 옮긴 줄은 다시 옮기지 않는다(쓰기 전 키 조회로 '이미 이동됨'을 결과에 넣고 끊겼던 배정만 마저 채움, 동시 요청은 유니크 23505 가 막음).
//  같은 키에 다른 내용(칸·수량·날짜)이 저장된 줄이 하나라도 있으면 신규 줄은 쓰지 않고 409 — 이미 옮겨진 줄은 전부 results 에 싣는다.
//  키를 품목으로 짓는 이유: 부분 실패 뒤 화면이 성공한 줄을 지우고 다시 보내도 순번이 밀리지 않게.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const from = toInvChannelParam(b.from);
    const to = toInvChannelParam(b.to);
    if (!from || !to) return NextResponse.json({ ok: false, error: "채널이 올바르지 않습니다." }, { status: 400 });
    if (from === to) return NextResponse.json({ ok: false, error: "옮길 채널이 서로 달라야 합니다." }, { status: 400 });
    // 이동으로만 채우는 칸끼리는 직행 금지 — 한쪽은 반드시 소매다(회계 경로 단순화, 113·115).
    //  도매↔프로모션뿐 아니라 도매↔도매 대량(일반 도매가 선결제분을 끌어가는 경로)도 이 한 줄로 막힌다.
    if (from !== "소매" && to !== "소매")
      return NextResponse.json({ ok: false, error: `${MOVE_ONLY_CHANNELS.join("·")} 끼리는 직접 옮길 수 없습니다 — 소매를 거쳐 주세요.` }, { status: 400 });

    // 입력 정규화 — 신형 items[] 없으면 구형 단일 바디를 1줄짜리로 감싼다
    type ItemIn = { product_id: string; qty: number; allocations: ManualAlloc[] };
    const parseAllocs = (v: unknown): ManualAlloc[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
      .map((a) => ({ item_id: String(a.item_id || ""), qty: Math.round((Number(a.qty) || 0) * 100) / 100 }))
      .filter((a) => a.item_id && a.qty > 0);
    const rawItems = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : null;
    const items: ItemIn[] = (rawItems ?? [b]).map((it) => ({
      product_id: String(it.product_id || ""),
      qty: Math.round((Number(it.qty) || 0) * 100) / 100,
      allocations: parseAllocs(it.allocations),
    }));
    if (!items.length) return NextResponse.json({ ok: false, error: "옮길 품목을 1개 이상 입력하세요." }, { status: 400 });
    for (const it of items) {
      if (!it.product_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
      if (it.qty <= 0) return NextResponse.json({ ok: false, error: "옮길 수량을 입력하세요." }, { status: 400 });
    }
    if (new Set(items.map((it) => it.product_id)).size !== items.length)
      return NextResponse.json({ ok: false, error: "같은 품목이 두 줄에 있습니다 — 한 줄로 합쳐 주세요." }, { status: 400 });

    const kstToday = kstTodayIso();
    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : kstToday;
    // 미래 날짜 금지 — 프로모션 마감 합류가 오늘까지의 풀을 오늘 날짜로 빼므로(옛 자동 합류 크론도 같았다), 미래분이 섞이면
    //  기준일 조회에서 프로모션 음수·소매 과대가 난다(감사 #64). 이동은 '한 일'의 기록이라 오늘까지만.
    if (txn_date > kstToday) return NextResponse.json({ ok: false, error: "옮긴 날짜는 오늘 이후로 할 수 없습니다." }, { status: 400 });
    const memo = String(b.memo || "").trim() || null;
    const created_by = await actor(req);
    const sb = supabaseAdmin();
    const requestKey = parseRequestKey(b.request_key);

    // 세트는 자체 재고가 없다(S5) — 세트 id 로 칸 이동을 남기면 구성품은 그대로이고 세트 행은 화면에서 숨겨진다.
    //  구성 조회 실패는 getAllBundles 가 던진다(S4).
    {
      const bundles = await getAllBundles(sb);
      if (items.some((it) => isBundleId(bundles, it.product_id)))
        return NextResponse.json({ ok: false, error: "묶음(세트)은 자체 재고가 없어 옮길 수 없습니다 — 구성품을 옮기세요." }, { status: 400 });
      // '재고 관리 사용 안함'(121) 품목은 원장에 남기지 않는다(S5) — 화면 필터만으로 막지 않는다. 조회 실패는 getUntracked 가 던진다(S4).
      const untracked = await getUntracked(sb);
      if (items.some((it) => untracked.ids.has(it.product_id)))
        return NextResponse.json({ ok: false, error: "'재고 관리 사용 안함' 품목은 옮길 수 없습니다." }, { status: 400 });
    }

    // 요청서 수동 배정(2026-09-14·113·115) — 소매에서 '이동으로만 채우는 칸'으로 옮길 때만.
    //  목적지 칸 → 생산 용도는 PURPOSE_CHANNEL 의 역인덱스(도매=도매 납품 · 프로모션=프로모션 · 도매 대량=도매 대량).
    //  줄마다 합계 ≤ 이동 수량(잔여=기타). 이동(원장) 기록 전에 '전 줄'을 검증해 잘못된 배정이면 아무것도 기록하지 않는다.
    const allocPurpose: AllocPurpose =
      (PR_PURPOSES.filter((p): p is AllocPurpose => p !== "재고 보충").find((p) => PURPOSE_CHANNEL[p] === to)) ?? "도매 납품";
    // 재시도 판정(131) — 같은 제출 키로 이미 기록된 줄을 '쓰기 전에' 전부 나눈다: 일치(두 편·칸·수량·날짜 같음 → 다시 옮기지 않음),
    //  충돌(같은 키인데 내용이 다름), 신규. 충돌이 하나라도 있으면 신규 줄은 쓰지 않고 409 — 루프 중간에 멈추면 같은 키로 이미
    //  옮겨진 뒷줄이 결과에 안 실려, 화면이 새 키로 그 줄을 다시 보내 두 번 옮긴다(S2). 일치한 줄은 결과에 실어 화면이 지우게 한다.
    //  조회 실패면 아무것도 쓰지 않는다(S4). 131 미적용이면 키가 없으니 종전 동작.
    type PrevLeg = { id: string; product_id: string; type: string; channel: string | null; qty: unknown; group_id: string | null; txn_date: string | null };
    const PREV_SEL = "id, product_id, type, channel, qty, group_id, txn_date";
    const legsMatch = (legs: PrevLeg[], it: ItemIn): { out: PrevLeg; in: PrevLeg } | null => {
      const o = legs.filter((l) => l.type === "출고"), n = legs.filter((l) => l.type === "입고");
      if (legs.length !== 2 || o.length !== 1 || n.length !== 1) return null;
      const same = (l: PrevLeg, ch: string, signed: number) =>
        l.channel === ch && Math.abs((Number(l.qty) || 0) - signed) <= 0.001 && String(l.txn_date || "").slice(0, 10) === txn_date;
      return same(o[0], from, -it.qty) && same(n[0], to, it.qty) ? { out: o[0], in: n[0] } : null;
    };
    const replayOf = new Map<string, { out: PrevLeg; in: PrevLeg }>();
    const conflicts: string[] = []; // 같은 키로 다른 내용이 저장된 품목(product_id)
    if (requestKey) {
      const prev = await loadByRequestKey<PrevLeg>(sb, requestKey, PREV_SEL);
      if (prev.error && !isMissing131({ message: prev.error }))
        return NextResponse.json({ ok: false, error: "이미 옮겼는지 확인하지 못했습니다 — 최근 옮긴 내역을 먼저 확인하세요." }, { status: 503 });
      const byPid = new Map<string, PrevLeg[]>();
      for (const r of prev.rows) byPid.set(String(r.product_id), [...(byPid.get(String(r.product_id)) || []), r]);
      for (const it of items) {
        const legs = byPid.get(it.product_id);
        if (!legs?.length) continue;
        const m = legsMatch(legs, it);
        if (m) replayOf.set(it.product_id, m); else conflicts.push(it.product_id);
      }
    }
    const preConflict = conflicts.length > 0;

    //  이미 옮겨진 줄은 다시 검증하지 않는다 — 첫 요청의 배정으로 요청서가 자동 완료됐으면 검증이 실패해 남은 줄까지 못 옮긴다.
    //  그 줄의 배정은 아래에서 '아직 안 들어간 것만' 채운다. 충돌이 있으면 신규 줄을 쓰지 않으니 검증도 하지 않는다.
    for (const it of items) {
      if (!it.allocations.length || preConflict || replayOf.has(it.product_id)) continue;
      if (!(from === "소매" && MOVE_ONLY_CHANNELS.includes(to)))
        return NextResponse.json({ ok: false, error: `요청서 배정은 소매 → ${MOVE_ONLY_CHANNELS.join("/")} 이동에서만 가능합니다.` }, { status: 400 });
      const allocSum = Math.round(it.allocations.reduce((s, a) => s + a.qty, 0) * 100) / 100;
      if (allocSum > it.qty + 0.001)
        return NextResponse.json({ ok: false, error: `배정 합계(${allocSum})가 이동 수량(${it.qty})보다 많은 품목이 있습니다.` }, { status: 400 });
      const v = await validateManualAllocations(sb, it.product_id, it.allocations, allocPurpose);
      if (!v.ok) return NextResponse.json({ ok: false, error: v.error || "배정 검증 실패" }, { status: 400 });
    }

    // 품목명(알림·오류 표시용)
    const nameById = new Map<string, { name: string; sku: string | null }>();
    try {
      const { data: prods } = await sb.from("products").select("id, name, sku").in("id", items.map((it) => it.product_id));
      for (const p of prods ?? []) nameById.set(p.id as string, { name: String(p.name || "품목"), sku: (p.sku as string) ?? null });
    } catch { /* 이름 없이 진행 */ }

    // 프로모션 → 소매 수동 이동이 열린 프로모션 요청서의 몫까지 빼는지(#5) — 확보분 합류는 요청서 '마감'·'취소'로 한다(2026-10-06 대표 결정).
    //  몫까지 빼면 요청서 이행엔 확보로 남는데 칸엔 물건이 없다. 확인(confirm_reserved)을 받은 뒤에만 옮긴다.
    //  이미 옮겨진 재시도 줄은 보지 않는다(풀이 이미 줄어 있다). 몫을 확인하지 못하면 옮기지 않는다(S4).
    //  409 code 'promo_reserved' — error 는 확인창을 모르는 화면이 그대로 띄우는 안내(우회 경로만: 요청서 '마감' 또는 몫 밖 수량으로 줄이기),
    //  confirm 은 확인창 문구. 확인창을 아는 화면은 confirm 으로 묻고 같은 request_key 에 confirm_reserved:true 를 붙여 다시 보낸다
    //  (409 전에는 아무것도 쓰지 않으므로 같은 키 재전송은 새 이동이 된다).
    if (from === "프로모션" && to === "소매" && !preConflict && b.confirm_reserved !== true) {
      const freshItems = items.filter((it) => !replayOf.has(it.product_id));
      const hits = freshItems.length ? await promoReservedHits(sb, freshItems, kstToday) : [];
      if (hits === null)
        return NextResponse.json({ ok: false, error: "열린 프로모션 요청서 몫을 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요." }, { status: 503 });
      if (hits.length) {
        const lines = hits.map((h) => `${nameById.get(h.product_id)?.name || "품목"} — 몫에서 ${h.qty.toLocaleString()}개(${h.req_nos.join("·") || "요청서"}), 몫 밖 ${h.free.toLocaleString()}개`).join(", ");
        return NextResponse.json({
          ok: false, code: "promo_reserved", reserved: hits,
          error: `열린 프로모션 요청서 몫까지 소매로 나갑니다: ${lines}. 행사 몫을 소매로 돌리려면 생산 요청에서 그 요청서를 '마감'하세요. 몫 밖 수량까지만 옮기려면 수량을 줄이세요.`,
          confirm: `열린 프로모션 요청서 몫까지 소매로 나갑니다: ${lines}.\n옮기면 요청서엔 확보로 남는데 프로모션 칸엔 물건이 없게 됩니다. 행사 몫은 보통 생산 요청에서 그 요청서를 '마감'해 소매로 돌립니다.\n\n그래도 옮길까요?`,
        }, { status: 409 });
      }
    }

    // ── 줄 단위 기록 — 각 줄이 독립 group(개별 취소 가능). 중간 실패 시 앞 줄들은 유지하고 알린다.
    const warnings: string[] = [];
    const results: { product_id: string; group_id: string }[] = [];
    const notifyPerItem: string[] = []; // 게시물 본문 — 품목별 수량·배정 요약(성공한 줄만 쌓임)

    // 알림 발송(성공한 줄 기준) — 정상 완료와 '중간 실패로 조기 반환' 양쪽에서 부른다.
    //  실패 경로에서 건너뛰면 앞 줄들이 원장·배정까지 반영됐는데 게시물이 0건이 된다(검증 확정).
    const notifyMove = async (doneItems: ItemIn[]) => {
      // 알림 대상: 소매→도매(도매 요청 대응) + 보호 칸(프로모션·도매 대량) 관련 이동(확보·해제). 도매→소매는 종전대로 무알림.
      const reserved = RESERVED_CHANNELS.includes(from) || RESERVED_CHANNELS.includes(to);
      if (!((from === "소매" && to === "도매") || reserved) || !doneItems.length) return;
      try {
        try {
          const [fs, ts] = await Promise.all([
            sb.rpc("inventory_stock", { asof: null, chan: from }).in("product_id", doneItems.map((it) => it.product_id)),
            sb.rpc("inventory_stock", { asof: null, chan: to }).in("product_id", doneItems.map((it) => it.product_id)),
          ]);
          const toMap = (x: { data?: unknown }) => new Map(((x.data as { product_id?: string; qty?: unknown }[] | null) ?? []).map((r) => [String(r.product_id), Number(r.qty)]));
          const fm = toMap(fs), tm = toMap(ts);
          const stockLines = doneItems
            .filter((it) => Number.isFinite(fm.get(it.product_id) ?? NaN) && Number.isFinite(tm.get(it.product_id) ?? NaN))
            .map((it) => `  ${nameById.get(it.product_id)?.name || "품목"}: ${from} ${(fm.get(it.product_id) as number).toLocaleString()} · ${to} ${(tm.get(it.product_id) as number).toLocaleString()}`);
          if (stockLines.length) notifyPerItem.push("이동 후 재고", ...stockLines);
        } catch { /* 재고 줄 생략 */ }
        const totalQty = doneItems.reduce((s, it) => s + it.qty, 0);
        const firstName = nameById.get(doneItems[0].product_id)?.name || "품목";
        const title = doneItems.length === 1 ? firstName : `${firstName} 외 ${doneItems.length - 1}종`;
        const firstSku = doneItems.length === 1 ? nameById.get(doneItems[0].product_id)?.sku ?? null : null;
        if (from === "소매" && to === "도매") await logInventoryMovedToWholesale(title, firstSku, totalQty, memo, created_by, notifyPerItem.join("\n"));
        else await logInventoryPoolMoved(from, to, title, firstSku, totalQty, memo, created_by, notifyPerItem.join("\n"));
      } catch (e) { console.warn("[inventory/move] 이전 알림 실패", e); }
    };

    // 요청서 재판정은 이동 1회에 요청서당 1번 — 줄마다 돌리면 다품목 배정에서 '요청→진행중→완료' 이중 전환·이중 알림이 난다(감사 #40).
    const recheckIds = new Set<string>();
    const recheckOnce = async () => {
      if (!recheckIds.size) return;
      try { await recheckRequestCompletion(sb, [...recheckIds], "요청서 배정"); } catch (e) { console.warn("[inventory/move] 배정 재판정 실패", e); }
    };
    let allocatedTotal = 0; // 실제 기록된 배정 합(건너뛴 배정 제외) — 응답·화면 성공 문구용(감사 #41)

    let fresh = 0; // 이번 요청에서 새로 기록한 줄 수 — 0 이면(전부 재시도분) 알림을 다시 보내지 않는다
    let use131 = true; // 131 미적용이면 첫 실패에서 끄고 그 뒤 줄은 새 칸 없이 기록(중복 방지 없음 — 종전 동작)
    const doneItems = () => items.filter((x) => results.some((r) => r.product_id === x.product_id));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (conflicts.includes(it.product_id)) continue; // 같은 키로 다른 내용 — 쓰지 않고 끝에서 409
      const pre = replayOf.get(it.product_id);
      if (preConflict && !pre) continue; // 충돌이 있으면 신규 줄은 쓰지 않는다 — 폼에 남아 확인 뒤 다시 보낸다
      let group_id: string = crypto.randomUUID();
      let data: { id: string; type: string; qty: unknown }[] | null = null;
      let error: { message: string; code?: string } | null = null;
      // 같은 제출 키로 이 줄은 이미 옮겨졌다(응답이 끊긴 뒤 재시도) — 다시 옮기지 않고 그 기록을 결과로 쓴다.
      let match = pre ?? null;
      if (!match) {
        const legs = (): Record<string, unknown>[] => {
          const base = { product_id: it.product_id, partner: MARK, memo, group_id, txn_date, status: "완료", created_by };
          const extra = (side: "out" | "in"): Record<string, unknown> => (use131
            ? { source: "move", source_ref: group_id, ...(requestKey ? { request_key: `${requestKey}:${it.product_id}:${side}` } : {}) }
            : {});
          return [
            { ...base, type: "출고", qty: -it.qty, channel: from, unit_amount: null, ...extra("out") },
            { ...base, type: "입고", qty: it.qty, channel: to, unit_amount: null, ...extra("in") },
          ];
        };
        let ins = await sb.from("inventory_txns").insert(legs()).select("id, type, qty");
        if (ins.error && isMissing131(ins.error)) { use131 = false; ins = await sb.from("inventory_txns").insert(legs()).select("id, type, qty"); }
        data = ins.data as { id: string; type: string; qty: unknown }[] | null;
        error = ins.error;
        // 사전 조회 뒤 같은 키가 끼어들었다(동시 요청·더블클릭) — 다시 읽어 일치면 그 기록을 쓰고, 다르면 이 줄만 충돌로 남기고 계속한다
        //  (멈추면 뒷줄이 결과에 안 실린다 — 위와 같은 이유). 다시 읽지 못하면 멈춘다(S4) — 키는 그대로라 같은 키 재시도는 안전하다.
        if (error && isDupRequestKey(error) && requestKey) {
          const { data: prev, error: pe } = await sb.from("inventory_txns").select(PREV_SEL)
            .in("request_key", [`${requestKey}:${it.product_id}:out`, `${requestKey}:${it.product_id}:in`]);
          if (pe) {
            const nm = nameById.get(it.product_id)?.name || `${i + 1}번째 품목`;
            await recheckOnce(); // 앞 줄에서 이미 기록된 배정의 완료 판정은 유지
            if (fresh) await notifyMove(doneItems());
            return NextResponse.json({
              ok: false, error: `${nm}: 이미 옮겼는지 확인하지 못했습니다 — 최근 옮긴 내역을 먼저 확인하세요.`, results, warnings,
            }, { status: 503 });
          }
          match = legsMatch((prev ?? []) as unknown as PrevLeg[], it);
          if (!match) { conflicts.push(it.product_id); continue; }
        }
      }
      const replayed = !!match;
      if (match) {
        group_id = String(match.in.group_id || match.out.group_id || group_id);
        data = [match.out, match.in].map((t) => ({ id: String(t.id), type: String(t.type), qty: t.qty }));
        error = null;
      }
      if (error) {
        if (/channel_chk|check constraint/i.test(error.message) && (from === "도매 대량" || to === "도매 대량"))
          return NextResponse.json({ ok: false, error: "도매 대량 칸이 아직 없습니다 — migration 115 를 먼저 적용하세요." }, { status: 500 });
        if (/channel_chk|check constraint/i.test(error.message) && (from === "프로모션" || to === "프로모션"))
          return NextResponse.json({ ok: false, error: "프로모션 풀이 아직 없습니다 — migration 113 을 먼저 적용하세요." }, { status: 500 });
        if (/channel/i.test(error.message)) return NextResponse.json({ ok: false, error: "채널 컬럼이 없습니다 — migration 036 을 먼저 적용하세요." }, { status: 500 });
        const nm = nameById.get(it.product_id)?.name || `${i + 1}번째 품목`;
        const done = results.length;
        await recheckOnce(); // 앞 줄에서 이미 기록된 배정의 완료 판정은 유지
        if (fresh) await notifyMove(doneItems()); // 이번에 새로 이동된 앞 줄들은 게시물로 알린다(전부 재시도분이면 이미 게시됨)
        return NextResponse.json({
          ok: false,
          error: `${nm} 이동 기록에 실패했습니다(${error.message}).${done ? ` 앞의 ${done}개 품목은 이동됐습니다 — 내역에서 확인·취소할 수 있습니다.` : ""}`,
          results, warnings,
        }, { status: 500 });
      }
      if (!replayed) fresh++;
      results.push({ product_id: it.product_id, group_id });

      // 배정(소매 → 도매·프로모션·도매 대량) — 실패해도 이동은 유지, 경고로 알림
      const nm = nameById.get(it.product_id)?.name || "품목";
      let allocatedSum = 0;
      const itemLines: string[] = [];
      if (from === "소매" && MOVE_ONLY_CHANNELS.includes(to) && it.allocations.length) {
        try {
          const inLeg = (data ?? []).find((t) => t.type === "입고" && Number(t.qty) > 0);
          // 재시도분이면 이 입고편에 아직 안 들어간 배정만 — 끊긴 배정을 마저 채우고, 이미 들어간 배정은 다시 넣지 않는다
          let allocs = it.allocations;
          let priorAlloc = 0; // 첫 요청에서 이미 들어간 배정 — 응답의 '배정' 합에 포함
          if (inLeg && replayed) {
            const { data: had, error: he } = await sb.from("production_receipts").select("item_id, qty").eq("inv_txn_id", inLeg.id).limit(2000);
            if (he) throw he;
            const linked = new Set((had ?? []).map((r) => String(r.item_id)));
            priorAlloc = Math.round((had ?? []).reduce((s2, r) => s2 + (Number(r.qty) || 0), 0) * 100) / 100;
            allocs = allocs.filter((a) => !linked.has(a.item_id));
          }
          allocatedSum = priorAlloc;
          if (inLeg && allocs.length) {
            const r = await applyManualAllocations(sb, {
              inv_txn_id: inLeg.id as string, product_id: it.product_id, receipt_date: txn_date,
              allocations: allocs, actor: created_by, purpose: allocPurpose,
            });
            warnings.push(...r.warnings.map((w) => `${nm}: ${w}`));
            itemLines.push(...r.lines.map((l) => `  ${l}`));
            // 실제 기록된 수량만 '배정'으로 센다 — 그 사이 닫힌 요청서로 건너뛴 배정은 기타로 남는다.
            allocatedSum = Math.round((priorAlloc + r.applied) * 100) / 100;
            for (const rid of r.requestIds) recheckIds.add(rid);
          }
        } catch (e) {
          console.warn("[inventory/move] 요청서 배정 실패", e);
          warnings.push(`${nm}: 요청서 배정 기록에 실패했습니다 — 이동은 저장됐으니 취소 후 다시 시도하세요.`);
        }
      }
      allocatedTotal += allocatedSum;
      const etc = Math.round((it.qty - allocatedSum) * 100) / 100;
      const skuTag = nameById.get(it.product_id)?.sku ? ` [${nameById.get(it.product_id)!.sku}]` : "";
      notifyPerItem.push(`- ${nm}${skuTag} ×${it.qty.toLocaleString()}${allocatedSum > 0 && etc > 0 ? ` (배정 ${allocatedSum.toLocaleString()} · 기타 ${etc.toLocaleString()})` : allocatedSum > 0 ? "" : " (기타)"}`);
      notifyPerItem.push(...itemLines);
    }

    await recheckOnce();
    // ── 알림 — 한 번의 이동 = 한 게시물(품목별 요약 + 이동 후 재고). 실패해도 이동은 성공.
    //  전부 재시도분이면(첫 요청이 끝까지 돌고 응답만 끊긴 경우) 이미 게시됐으므로 다시 보내지 않는다.
    if (fresh) await notifyMove(doneItems());

    // 같은 키로 다른 내용이 저장된 줄이 있었다 — results(이미 옮겨진 줄 전부)는 화면이 폼에서 지우고, 충돌·미처리 줄은 남는다.
    //  화면은 키를 새로 만든다 → 사람이 내역을 확인한 뒤 다시 누르면 남은 줄만 새 이동이 된다.
    if (conflicts.length) {
      const names = conflicts.map((pid) => nameById.get(pid)?.name || "품목").join(", ");
      const skipped = items.length - results.length - conflicts.length; // 충돌 때문에 쓰지 않은 신규 줄
      return NextResponse.json({
        ok: false, code: "request_key_conflict",
        error: `${names}: ${REQUEST_KEY_CONFLICT_MSG.replace("[입고 및 출고] 목록", "최근 옮긴 내역")}`
          + (results.length ? ` 이미 옮겨진 ${results.length}개 품목은 목록에서 뺐습니다.` : "")
          + (skipped > 0 ? ` 나머지 ${skipped}개 품목은 옮기지 않았습니다.` : ""),
        results, conflicts, warnings, allocated: Math.round(allocatedTotal * 100) / 100,
      }, { status: 409 });
    }

    return NextResponse.json({ ok: true, results, replay: fresh === 0, group_id: results[0]?.group_id ?? null, count: results.length * 2, warnings, allocated: Math.round(allocatedTotal * 100) / 100 });
  } catch (err) {
    console.error("[inventory/move POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "이동 실패") }, { status: 500 });
  }
}

// DELETE ?group_id= — 이동 취소(양쪽 채널 원복). 마커가 채널이동인 행만 삭제.
//  배정된 요청서는 cascade(083)로 증거가 함께 지워진다 — 그 취소로 100% 아래로 내려간
//  자동 완료 요청은 다시 '진행중'으로 재개해 종합에 재등장시킨다.
export async function DELETE(req: NextRequest) {
  try {
    const group_id = req.nextUrl.searchParams.get("group_id");
    if (!group_id) return NextResponse.json({ ok: false, error: "group_id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();

    // 취소로 입고편 채널이 '어느 시점에라도' 마이너스가 되면 중단 — 예: 소매→프로모션 M1 뒤 마감 합류 R(풀→소매)이
    //  나가고 M2 로 다시 채운 상태에서 M1 을 취소하면, 현재 잔량으로는 통과하는데 R 직후가 −가 되어 M2 확보분이
    //  장부에서 사라진다(감사 #14). 그래서 현재 잔량이 아니라 '이 입고편을 뺀' 시간순 누적 잔량의 최솟값을 본다.
    //  루프 뒤 최종 누적값(= 현재 잔량 − 이 입고편)도 최솟값에 넣어 종전 현재고 검사를 포함한다(마지막 행 취소 대비).
    //  시간순 검사는 이동 전용 칸(도매·프로모션·도매 대량)만 — 소매는 입고 기록이 늦게 들어와 시간순으로 잠깐 −가 되는 게
    //  정상이라(판매가 먼저 찍힘) 시간순으로 보면 정당한 취소(마감 합류 되돌리기 등)까지 막힌다. 소매는 현재 잔량만 본다.
    //  어느 조회든 실패하면 취소하지 않는다(S4) — '판정 불가 = 허용'이면 일시 오류 한 번에 칸이 마이너스가 된다.
    const unknown = () => NextResponse.json({ ok: false, error: "취소 가능 여부를 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요." }, { status: 503 });
    const { data: legsRaw, error: legsErr } = await sb.from("inventory_txns")
      .select("*").eq("group_id", group_id).eq("partner", MARK); // * = 131 미적용(source 없음)에도 안전
    if (legsErr) return unknown();
    type Leg = { id: string; product_id: string; channel: string; qty: unknown; type: string; memo?: string | null; source?: string | null; source_ref?: string | null };
    const legs = (legsRaw ?? []) as Leg[];

    // 프로모션 마감·취소 합류(S7) — 요청서가 닫힌(완료·취소) 채 되돌리면 확보분이 어느 요청서 몫도 아닌 채 프로모션 칸에 남고,
    //  다른 요청서를 마감할 때 함께 소매로 끌려간다. 생산 요청에서 그 요청서를 먼저 다시 열어(요청·진행중) 몫이 보호된 뒤에만 취소한다.
    //  요청서는 서버가 쓴 메모 '프로모션 마감|취소 · <요청번호>'(promoCloseMemo)로 찾는다. 번호가 없는 옛 크론 합류는 종전대로.
    {
      //  판정은 출처 칸(131 source 'promo_close', source_ref = 요청서 id)으로 — 메모는 출처 칸이 없는 옛 행에서만 본다(S11:
      //  사람 이동의 메모에 같은 문구를 적어도 합류로 오인하지 않게).
      const promo = legs.find((l) => l.source === "promo_close" || (!l.source && /^프로모션 (마감|취소)/.test(String(l.memo || ""))));
      const reqNo = promo ? (String(promo.memo || "").match(/^프로모션 (?:마감|취소) · (.+)$/)?.[1] ?? "").trim() : "";
      const refId = promo && /^[0-9a-f-]{36}$/i.test(String(promo.source_ref || "")) ? String(promo.source_ref) : "";
      if (promo && (reqNo || refId)) {
        const q = sb.from("production_requests").select("id, req_no, status");
        const { data: reqs, error: rqErr } = refId ? await q.eq("id", refId).limit(1) : await q.eq("req_no", reqNo).limit(5);
        if (rqErr) return unknown();
        const closed = (reqs ?? []).find((r) => r.status === "완료" || r.status === "취소");
        if (closed)
          return NextResponse.json({ ok: false, error: `프로모션 ${closed.status === "취소" ? "취소" : "마감"} 합류입니다 — 생산 요청에서 ${closed.req_no || "그 요청서"}를 먼저 다시 연 뒤 취소하세요.` }, { status: 409 });
      }
    }

    for (const leg of legs.filter((l) => l.type === "입고")) {
      if (MOVE_ONLY_CHANNELS.includes(String(leg.channel) as (typeof MOVE_ONLY_CHANNELS)[number])) {
        // 같은 품목·칸의 완료 행 전량을 시간순으로(RPC inventory_stock 과 같은 status='완료' 기준). 조회 실패는 폴백 없이 멈춘다(034 는 적용돼 있다).
        const rows: { id: string; qty: unknown }[] = [];
        for (let off = 0; off < 100000; off += 1000) {
          const { data, error } = await sb.from("inventory_txns").select("id, qty")
            .eq("product_id", String(leg.product_id)).eq("channel", String(leg.channel)).eq("status", "완료")
            .order("txn_date", { ascending: true }).order("created_at", { ascending: true }).order("id", { ascending: true })
            .range(off, off + 999);
          if (error) return unknown();
          rows.push(...((data ?? []) as { id: string; qty: unknown }[]));
          if ((data ?? []).length < 1000) break;
        }
        // 이 입고편이 없었다면 −가 되는 시점 중, 입고편 덕에 0 이상이던 시점만 문제로 본다 — 원래부터 −였던 시점
        //  (발송일에 선점이 먼저 찍히고 이동이 뒤따른 도매·도매 대량의 흔한 흐름)은 이 취소 탓이 아니라 막지 않는다.
        //  최종 잔량(현재 − 입고편)은 늘 본다(종전 현재고 검사, 마지막 행 취소 포함).
        const legQty = Number(leg.qty) || 0;
        let run = 0, after = false, bad = false;
        for (const r of rows) {
          if (r.id === leg.id) { after = true; continue; }
          run += Number(r.qty) || 0;
          if (after && run < -0.001 && run + legQty >= -0.001) bad = true;
        }
        if (after && run < -0.001) bad = true;
        if (bad)
          return NextResponse.json({ ok: false, error: `취소하면 ${leg.channel} 재고가 이후 시점에 마이너스가 됩니다 — 이 이동 이후에 기록된 ${leg.channel} 칸의 출고·이동(프로모션 마감 합류 등)을 먼저 취소하세요.` }, { status: 409 });
        continue;
      }
      // 소매 입고편(도매→소매 이동·마감 합류) — 현재 잔량만 본다. 오류·판독 불가는 멈춘다(이 칸의 유일한 검사다).
      const { data: st, error: stErr } = await sb.rpc("inventory_stock", { asof: null, chan: String(leg.channel) })
        .eq("product_id", String(leg.product_id)).maybeSingle();
      if (stErr) return unknown();
      const cur = Number((st as { qty?: unknown } | null)?.qty ?? 0);
      if (!Number.isFinite(cur)) return unknown();
      if (cur - (Number(leg.qty) || 0) < -0.001)
        return NextResponse.json({ ok: false, error: `취소하면 ${leg.channel} 재고가 마이너스가 됩니다 — 이 이동 이후에 기록된 이동(프로모션 마감 합류 등)을 먼저 취소하세요.` }, { status: 409 });
    }

    // cascade 로 사라지기 전에 영향 요청 수집 — 조회가 실패하면 취소 자체를 중단(fail-closed).
    //  여기서 삭제만 진행되면 '이행률은 내려갔는데 상태는 완료'로 굳고 재판정할 트리거가 없다(검증 확정).
    let affected: string[] = [];
    {
      const { data: txns, error: te } = await sb.from("inventory_txns").select("id").eq("group_id", group_id).eq("partner", MARK);
      if (te) return NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
      const ids = (txns ?? []).map((t) => t.id as string);
      // 0행 = 이미 취소됐거나 이동이 아닌 group — ok:true 로 넘기면 화면이 '취소됨'으로 믿는다(감사 #19 와 같은 결함)
      if (!ids.length) return NextResponse.json({ ok: false, error: "취소할 이동 기록을 찾지 못했습니다 — 새로고침 후 다시 시도하세요." }, { status: 404 });
      {
        const { data: rcs, error: re } = await sb.from("production_receipts").select("request_id").in("inv_txn_id", ids).limit(2000);
        if (re) return NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
        affected = [...new Set((rcs ?? []).map((r) => r.request_id as string).filter(Boolean))];
      }
    }

    // 재개 대상 = '삭제 전에 이행 100%였던' 요청만 — 사람이 미달인 채 수동 완료한 요청은 건드리지 않는다.
    //  null = 조회 실패(receipts 가 있으니 요청서·품목은 존재) — 건너뛰고 지우면 '이행률은 내려갔는데 완료'로
    //  굳고 재판정 트리거가 없다(감사 #30). 취소 자체를 중단(fail-closed).
    const reopenIds: string[] = [];
    for (const rid of affected) {
      const f = await getRequestFullness(sb, rid);
      if (!f) return NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
      if (f.full) reopenIds.push(rid);
    }

    const { error } = await sb.from("inventory_txns").delete().eq("group_id", group_id).eq("partner", MARK);
    if (error) throw error;

    if (reopenIds.length) {
      try { await recheckRequestCompletion(sb, reopenIds, "이동 취소", "reopen"); }
      catch (e) { console.warn("[inventory/move] 취소 후 재판정 실패", e); }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/move DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
