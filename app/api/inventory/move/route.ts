import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logInventoryMovedToWholesale, logInventoryPoolMoved } from "@/app/lib/b2b-activity";
import { validateManualAllocations, applyManualAllocations, recheckRequestCompletion, getRequestFullness, type ManualAlloc, type AllocPurpose } from "@/app/lib/production-allocate";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { toInvChannelParam, MOVE_ONLY_CHANNELS, RESERVED_CHANNELS } from "@/app/lib/inventory";
import { PR_PURPOSES, PURPOSE_CHANNEL } from "@/app/lib/wholesale-production";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARK = "채널이동"; // partner 필드에 마커로 넣어 이동 내역을 구분·조회

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
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

    const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : kstToday;
    // 미래 날짜 금지 — 프로모션 마감 합류가 오늘까지의 풀을 오늘 날짜로 빼므로(옛 자동 합류 크론도 같았다), 미래분이 섞이면
    //  기준일 조회에서 프로모션 음수·소매 과대가 난다(감사 #64). 이동은 '한 일'의 기록이라 오늘까지만.
    if (txn_date > kstToday) return NextResponse.json({ ok: false, error: "옮긴 날짜는 오늘 이후로 할 수 없습니다." }, { status: 400 });
    const memo = String(b.memo || "").trim() || null;
    const created_by = await actor(req);
    const sb = supabaseAdmin();

    // 요청서 수동 배정(2026-09-14·113·115) — 소매에서 '이동으로만 채우는 칸'으로 옮길 때만.
    //  목적지 칸 → 생산 용도는 PURPOSE_CHANNEL 의 역인덱스(도매=도매 납품 · 프로모션=프로모션 · 도매 대량=도매 대량).
    //  줄마다 합계 ≤ 이동 수량(잔여=기타). 이동(원장) 기록 전에 '전 줄'을 검증해 잘못된 배정이면 아무것도 기록하지 않는다.
    const allocPurpose: AllocPurpose =
      (PR_PURPOSES.filter((p): p is AllocPurpose => p !== "재고 보충").find((p) => PURPOSE_CHANNEL[p] === to)) ?? "도매 납품";
    for (const it of items) {
      if (!it.allocations.length) continue;
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

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const group_id = crypto.randomUUID();
      const base = { product_id: it.product_id, partner: MARK, memo, group_id, txn_date, status: "완료", created_by };
      const { data, error } = await sb.from("inventory_txns").insert([
        { ...base, type: "출고", qty: -it.qty, channel: from, unit_amount: null },
        { ...base, type: "입고", qty: it.qty, channel: to, unit_amount: null },
      ]).select("id, type, qty");
      if (error) {
        if (/channel_chk|check constraint/i.test(error.message) && (from === "도매 대량" || to === "도매 대량"))
          return NextResponse.json({ ok: false, error: "도매 대량 칸이 아직 없습니다 — migration 115 를 먼저 적용하세요." }, { status: 500 });
        if (/channel_chk|check constraint/i.test(error.message) && (from === "프로모션" || to === "프로모션"))
          return NextResponse.json({ ok: false, error: "프로모션 풀이 아직 없습니다 — migration 113 을 먼저 적용하세요." }, { status: 500 });
        if (/channel/i.test(error.message)) return NextResponse.json({ ok: false, error: "채널 컬럼이 없습니다 — migration 036 을 먼저 적용하세요." }, { status: 500 });
        const nm = nameById.get(it.product_id)?.name || `${i + 1}번째 품목`;
        const done = results.length;
        await recheckOnce(); // 앞 줄에서 이미 기록된 배정의 완료 판정은 유지
        await notifyMove(items.slice(0, done)); // 이미 이동된 앞 줄들은 게시물로 알린다
        return NextResponse.json({
          ok: false,
          error: `${nm} 이동 기록에 실패했습니다(${error.message}).${done ? ` 앞의 ${done}개 품목은 이동됐습니다 — 내역에서 확인·취소할 수 있습니다.` : ""}`,
          results, warnings,
        }, { status: 500 });
      }
      results.push({ product_id: it.product_id, group_id });

      // 배정(소매 → 도매·프로모션·도매 대량) — 실패해도 이동은 유지, 경고로 알림
      const nm = nameById.get(it.product_id)?.name || "품목";
      let allocatedSum = 0;
      const itemLines: string[] = [];
      if (from === "소매" && MOVE_ONLY_CHANNELS.includes(to) && it.allocations.length) {
        try {
          const inLeg = (data ?? []).find((t) => t.type === "입고" && Number(t.qty) > 0);
          if (inLeg) {
            const r = await applyManualAllocations(sb, {
              inv_txn_id: inLeg.id as string, product_id: it.product_id, receipt_date: txn_date,
              allocations: it.allocations, actor: created_by, purpose: allocPurpose,
            });
            warnings.push(...r.warnings.map((w) => `${nm}: ${w}`));
            itemLines.push(...r.lines.map((l) => `  ${l}`));
            // 실제 기록된 수량만 '배정'으로 센다 — 그 사이 닫힌 요청서로 건너뛴 배정은 기타로 남는다.
            allocatedSum = r.applied;
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
    await notifyMove(items);

    return NextResponse.json({ ok: true, results, group_id: results[0]?.group_id ?? null, count: results.length * 2, warnings, allocated: Math.round(allocatedTotal * 100) / 100 });
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
    {
      const { data: inLegs } = await sb.from("inventory_txns")
        .select("id, product_id, channel, qty").eq("group_id", group_id).eq("partner", MARK).eq("type", "입고");
      for (const leg of inLegs ?? []) {
        let checked = false;
        if (MOVE_ONLY_CHANNELS.includes(String(leg.channel) as (typeof MOVE_ONLY_CHANNELS)[number])) try {
          // 같은 품목·칸의 완료 행 전량을 시간순으로(RPC inventory_stock 과 같은 status='완료' 기준)
          const rows: { id: string; qty: unknown }[] = [];
          for (let off = 0; off < 100000; off += 1000) {
            const { data, error } = await sb.from("inventory_txns").select("id, qty")
              .eq("product_id", String(leg.product_id)).eq("channel", String(leg.channel)).eq("status", "완료")
              .order("txn_date", { ascending: true }).order("created_at", { ascending: true }).order("id", { ascending: true })
              .range(off, off + 999);
            if (error) throw error;
            rows.push(...((data ?? []) as { id: string; qty: unknown }[]));
            if ((data ?? []).length < 1000) break;
          }
          checked = true;
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
        } catch { /* 시간순 조회 실패(status 미적용 등) — 아래 현재 잔량 검사로 폴백 */ }
        if (checked) continue;
        try {
          const { data: st } = await sb.rpc("inventory_stock", { asof: null, chan: String(leg.channel) })
            .eq("product_id", String(leg.product_id)).maybeSingle();
          const cur = Number((st as { qty?: unknown } | null)?.qty ?? NaN);
          if (Number.isFinite(cur) && cur - (Number(leg.qty) || 0) < -0.001)
            return NextResponse.json({ ok: false, error: `취소하면 ${leg.channel} 재고가 마이너스가 됩니다 — 이 이동 이후에 기록된 이동(프로모션 마감 합류 등)을 먼저 취소하세요.` }, { status: 409 });
        } catch { /* 판정 불가 시 기존 동작(취소 허용) */ }
      }
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
