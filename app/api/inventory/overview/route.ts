import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { toInvChannelParam } from "@/app/lib/inventory";
import { scheduleHorizon, kstTodayIso } from "@/app/lib/production-schedule";
import { getPromotionsWithOk, promoForwardFrom, promoSoldFrom } from "@/app/lib/production-promotions";
import { getAllBundles, bundleAvailable } from "@/app/lib/product-bundles";
import { getOpenInboundByProduct, formatInbound, getOpenRequestedByProduct, formatRequested, type InboundRow, type RequestedRow } from "@/app/lib/production-inbound";
import { getUntracked } from "@/app/lib/stock-tracked";
import { readAll, readStockMap, readScheduledOut } from "@/app/lib/inventory-template";
import { isMoveRow, isMissingSchemaError, NON_DEMAND_REASONS } from "@/app/lib/production-velocity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const daysInclusive = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400_000) + 1);

export type OverviewRow = {
  product_id: string; sku: string | null; name: string; spec: string | null; unit: string;
  attrs: string | null; // 속성/분류(상품마스터 자유 입력) — 재고 목록 검색용
  // qty = 가용(전체 원장 합 = 오늘 뒤 발송일 선점까지 뺀 값) — 부족·예상소진·생산 요청 창(RequestList)의 기준. 종전 '현재고' 값 그대로(D1: 생산 쪽 기준 불변)
  qty: number; cost_price: number;
  value: number;      // 재고자산 = 현재고(on_hand) × 원가 — 아직 안 나간 선점분도 창고에 있는 자산이다
  on_hand: number;    // 현재고 = 오늘(KST)까지 원장(D1) — 재고 목록 '현재고' 열, 실사 화면과 같은 기준
  scheduled_out: number;          // 출고 예정 = on_hand − qty(오늘 뒤 거래일로 이미 기록된 출고 — 대부분 B2B 선점). 0 미만은 0
  scheduled_first: string | null; // 그중 가장 이른 거래일
  scheduled_detail: string;       // 툴팁용 "10-20 거래처 300" 줄
  period_in: number; period_out: number; daily_out: number;
  auto_safety: number; promo_qty: number; depletion_days: number | null; low: boolean;
  promo_pool: number; // 프로모션 풀 잔량(113) — 소매 탭에서 현재고 옆 병기, 그 외 채널은 0
  inbound: number;    // 입고 예정 = 확정된 제조사 요청서 잔여(소매·전체 탭 — 부족 판정·권장 수식이 현재고에 더해 본다). 도매 탭 = 열린 도매 요청서 잔여(부족 판정 미포함). 도매 대량 탭은 0(프로모션 탭은 지금도 제조사 잔여가 보인다 — 코드와 계약이 어긋난 자리, 별건 결정 대기)
  inbound_due: string | null; // 잔여가 있는 요청서 중 가장 이른 생산마감일
  inbound_overdue: number;    // 그중 마감이 지난 잔여(서버 판정 — 자동 제외 없음, 표시용)
  inbound_detail: string;     // 툴팁용 요청서별 내역("PR-000123 300 (마감 09-25)")
  requested: number;          // 요청량 = 이 칸 용도(프로모션·도매 대량)의 열린 요청서 요청수량 합 — 확정형 탭만, 그 외 0
  requested_detail: string;   // 툴팁용 요청서별 내역("PR-000123 요청 300 · 이동 120 · 목표 10-05")
  is_bundle: boolean; // 묶음(세트) — 현재고는 '만들 수 있는 세트 수'(가용)
};

// GET /api/inventory/overview?from=&to=&channel= — 재고목록 고도화 뷰.
//  기간[from,to]의 총입고·총출고·일평균소진(행사 일정의 예상 판매량 제외) + 자동 목표(일평균소진 × 목표 일수 — 생산 일정 기반, production-schedule)
//  + 예상소진일수(가용 ÷ 일평균소진). 채널(도매/소매) 지정 시 그 채널 기준.
//  현재고(on_hand) = 오늘까지, 출고 예정 = 오늘 뒤 날짜로 이미 뺀 출고, 가용(qty) = 둘의 차 — 부족·예상소진·권장은 가용 기준 그대로(D1).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const today = kstTodayIso();
    const to = DATE_RE.test(String(sp.get("to"))) ? String(sp.get("to")) : today;
    let from = DATE_RE.test(String(sp.get("from"))) ? String(sp.get("from")) : to;
    if (from > to) from = to;
    const chan = toInvChannelParam(sp.get("channel")); // 전체·모르는 값 = null(전 칸 합산)
    const periodDays = daysInclusive(from, to);

    const sb = supabaseAdmin();
    // 목표 일수(오늘 → 다음 요청분 판매 가능일)·부족 기준 일수(오늘 → 오늘 요청분 판매 가능일) — 권장 수식과 같은 일정
    const { leadDays, cycleDays, horizonDays, sellable, nextDraft, nextSellable } = scheduleHorizon(today);

    // 입고 예정(확정된 제조사 요청서 잔여) — 소매·전체 탭에서 현재고 옆 병기 + 부족(low) 판정에 합산.
    //  권장 수식(getInventoryRows)이 같은 값을 현재고에 더해 빼므로, 여기서도 더해야 '부족인데 권장 0' 모순이 없다.
    //  도매 탭은 제조사 잔여 대신 열린 도매 요청서 잔여(이동 대기)를 보인다 — 부족 판정에는 넣지 않는다(아래 low).
    //  집계 실패(null)면 0 으로 두고 meta.inboundOk=false 로 알린다.
    // 확정형 탭(프로모션·도매 대량)의 요청량 — 그 칸 용도의 열린 요청서(2026-09-29 대표 요청). 집계 실패(null)면 0 + meta.requestedOk=false.
    const reqPurpose = chan === "프로모션" || chan === "도매 대량" ? chan : null;
    // 재고 = inventory_stock 을 페이지 끝까지(S1·S4). 036 미적용(chan 시그니처 없음 = PGRST202)만 전 칸 합으로 폴백하고
    //  일시 오류는 던진다 — 모든 오류에서 폴백하면 도매 대량 탭 등에 4칸 합이 현재고로 조용히 표시된다(#11).
    //  가용(asof 없음) = 부족·예상소진·생산 창 기준(종전 그대로), 현재고(asof 오늘) = 표시. 차이 = 출고 예정(S6·D1).
    type P = { id: string; sku: string | null; name: string; spec: string | null; unit: string; cost_price: number; attrs: string | null };
    const [products, stock, stockToday, schedOut, promos, bundles, inbound, untracked, requestedMap] = await Promise.all([
      readAll<P>((a, b) => sb.from("products").select("id, sku, name, spec, unit, cost_price, attrs").eq("active", true)
        .order("name", { ascending: true }).order("id", { ascending: true }).range(a, b)),
      readStockMap(sb, { asof: null, chan }),
      readStockMap(sb, { asof: today, chan }),
      readScheduledOut(sb, today, chan),
      getPromotionsWithOk(), // 행사 일정 — 남은 행사분(표시)·기간에 겹친 예상 판매량(하루 출고에서 뺌). 실패면 ok=false 로 알린다(S4)
      getAllBundles(sb),
      chan === "도매" ? getOpenInboundByProduct(sb, today, "도매 납품") // 도매 탭 = 열린 도매 요청서 잔여(소매→도매 이동 대기, 2026-09-29)
        : chan !== "도매 대량" && chan !== "프로모션" ? getOpenInboundByProduct(sb, today) : Promise.resolve(new Map<string, InboundRow>()), // 제조사 입고는 소매로만 온다 — 확정형 칸엔 '입고 예정'이 없다
      getUntracked(sb),
      reqPurpose ? getOpenRequestedByProduct(sb, reqPurpose) : Promise.resolve(new Map<string, RequestedRow>()),
    ]);
    const inboundOk = inbound !== null;
    const requestedOk = requestedMap !== null;
    // 행사 일정(소매 판매 장치): 남은 행사분은 표시용, 기간에 겹친 예상 판매량(일할)은 '하루 출고'에서 뺀다(2026-10-27 대표 요청 —
    //  하루 출고를 보며 생산량을 가늠하므로 권장생산의 평상시 속도(production-inventory promoSold)와 같은 규칙). 소매·전체 탭만(도매·확정형 칸은 행사가 아니다).
    //  전엔 표의 하루 출고가 행사 포함 원장값이었다(#45) — 권장과 두 숫자가 달라 혼동됐다.
    const promoFwd = promoForwardFrom(promos.list, today, horizonDays);
    const promoSold: Record<string, number> = chan === null || chan === "소매" ? promoSoldFrom(promos.list, from, to) : {};
    const stockOf = (id: string) => stock.get(id) || 0;
    const todayOf = (id: string) => stockToday.get(id) || 0;

    // 소매 탭: 프로모션 풀 잔량을 별도 필드로 병기(113) — 권장 수식(getInventoryRows)이 풀을 현재고로
    //  합산하므로, 부족(low) 판정도 소매+풀 기준으로 맞춰야 '부족인데 권장 0' 모순이 안 생긴다(검증 확정).
    //  표시 전용이라 현재고와 같은 기준(오늘까지)으로 읽는다. 읽기 실패면 병기 없음(판정에 쓰지 않는다).
    let promoPool = new Map<string, number>();
    if (chan === "소매") {
      //  036 미적용이면 칸이 없으니 풀도 없다(빈 맵) — 전 칸 합을 풀로 병기하지 않게
      try { promoPool = await readStockMap(sb, { asof: today, chan: "프로모션", onMissingChan: "empty" }); } catch { /* 113 미적용·일시 오류 — 병기 없음 */ }
    }

    // 기간 원장(입고/출고).
    //  ※ 단발 .limit(20000)은 서버 Max Rows(기본 1000)가 우선해 조용히 잘린다 — 30일 총입고/총출고가
    //    실제보다 적게 나오던 원인(2026-09-03 대표 보고). range 페이징으로 전량 읽는다(안정 정렬 필수).
    //  선택 칸: channel(036)·reason(099)·source(131)·order_no(033). 미적용 칸만 그 칸을 빼고 다시 읽는다(오류 메시지에 칸 이름이 보일 때).
    //  그 밖의 오류는 던진다 — 칸 없이 조용히 다시 읽으면 전 칸 합·이동 포함 소진이 표시된다(S4).
    //  channel 이 없으면(036 미적용) 칸 조건 없이 전체 — 그때는 칸이 소매 하나뿐이다.
    type TxnRow = { product_id: string; type: string; qty: number; status?: string | null; partner?: string | null; order_no?: string | null; reason?: string | null; source?: string | null };
    const optCols = new Set<string>(["channel", "reason", "source", "order_no"]); // order_no(033) — 옛 이동 판정(isMoveRow)에 쓴다
    const fetchTxns = () => readAll<TxnRow>((a, b) => {
      let q = sb.from("inventory_txns")
        .select(`product_id, type, qty, status, partner${[...optCols].map((c) => `, ${c}`).join("")}`)
        .in("type", ["입고", "출고"])
        .gte("txn_date", from).lte("txn_date", to);
      if (optCols.has("channel") && chan) q = q.eq("channel", chan);
      return q.order("id", { ascending: true }).range(a, b);
    });
    let txRows: TxnRow[] = [];
    for (;;) {
      try { txRows = await fetchTxns(); break; }
      catch (e) {
        const err = e as { message?: string; code?: string };
        const col = isMissingSchemaError(err) ? [...optCols].find((c) => new RegExp(`\\b${c}\\b`, "i").test(err.message || "")) : undefined;
        if (!col) throw e;
        optCols.delete(col);
      }
    }

    const inq = new Map<string, number>();
    const outq = new Map<string, number>();
    for (const t of txRows) {
      if (t.status != null && t.status !== "완료") continue; // 대기 제외
      const q = Math.abs(Number(t.qty) || 0);
      if (t.type === "입고") inq.set(t.product_id, (inq.get(t.product_id) || 0) + q);
      else if (t.type === "출고") {
        // 판매·납품이 아닌 출고는 총출고·일평균 소진·자동 안전재고에서 뺀다 — 판매속도 lib(getLedgerVelocity)와 같은 규칙(S1):
        //  칸 이동·프로모션 합류(isMoveRow — 출처 칸 source, 131 이전 기록은 주문번호 없는 partner '채널이동'), 사유 '제조사 반품'(NON_DEMAND_REASONS).
        //  총입고의 이동분은 그대로 둔다 — 대표 지시는 출고.
        if (isMoveRow(t)) continue;
        if (t.reason && NON_DEMAND_REASONS.has(t.reason)) continue;
        outq.set(t.product_id, (outq.get(t.product_id) || 0) + q);
      }
    }

    // '재고 관리 사용 안함'(121) 품목은 재고 목록에서 뺀다 — 드라이아이스 등(입·출·조정 창 품목 목록도 이 행을 쓴다)
    const rows: OverviewRow[] = products.filter((p) => !untracked.ids.has(p.id)).map((p) => {
      const comps = bundles.get(p.id);
      const isBundle = !!comps && comps.length > 0;
      // 묶음은 자체 재고 대신 '만들 수 있는 세트 수'(구성품 현재고 ÷ 구성수량의 최소값)
      const qty = isBundle ? bundleAvailable(comps!, stockOf, untracked.ids) : stockOf(p.id); // 세트 — 재고 관리 안 함 구성품(드라이아이스)은 빼고
      const onHand = isBundle ? bundleAvailable(comps!, todayOf, untracked.ids) : todayOf(p.id);
      const sched = schedOut.get(p.id);
      const cost = Number(p.cost_price) || 0;
      const period_in = inq.get(p.id) || 0;
      const period_out = outq.get(p.id) || 0;
      const skuKey = (p.sku || "").trim().toUpperCase();
      const promo_sold = Math.min(period_out, promoSold[skuKey] || 0); // 기간에 겹친 행사 예상 판매량(총출고를 넘지 않게)
      const daily_out = (period_out - promo_sold) / periodDays;        // 평상시 하루 출고(행사분 제외) — 예상소진·부족·목표도 이 값
      const promo = promoFwd[skuKey] || 0;
      const auto_safety = Math.ceil(daily_out * horizonDays); // 행사 가산은 빼다(결정 9) — promo 는 표시용
      const lead_safety = Math.ceil(daily_out * leadDays);    // 부족 기준 — 오늘 요청분 판매 가능일까지 버틸 양
      const depletion_days = daily_out > 0 ? Math.floor(qty / daily_out) : null;
      const inb = inbound?.get(p.id);
      const inbQty = inb?.qty ?? 0;
      return {
        product_id: p.id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, attrs: p.attrs ?? null,
        qty, cost_price: cost, value: onHand * cost,
        on_hand: onHand, scheduled_out: Math.max(0, Math.round((onHand - qty) * 100) / 100),
        scheduled_first: sched?.first ?? null, scheduled_detail: sched ? sched.lines.join("\n") + (sched.more ? `\n외 ${sched.more}건` : "") : "",
        period_in, period_out, daily_out: Math.round(daily_out * 10) / 10, promo_sold: Math.round(promo_sold * 10) / 10,
        auto_safety, promo_qty: Math.round(promo), depletion_days,
        promo_pool: Math.round((promoPool.get(p.id) || 0) * 100) / 100, // 프로모션 풀 잔량(소매 탭 병기용)
        inbound: inbQty, inbound_due: inb?.earliest_due ?? null, inbound_overdue: inb?.overdue_qty ?? 0, inbound_detail: formatInbound(inb, today),
        requested: requestedMap?.get(p.id)?.requested ?? 0, requested_detail: formatRequested(requestedMap?.get(p.id)),
        // 부족 = 가용(qty — 권장 수식과 같은 asof 없음 기준) + 입고 예정이 '오늘 요청분 판매 가능일까지 버틸 양' 미만(권장 수식 belowSafety 와 같은 엄격 비교 —
        //  '이하'면 목표 일수와 부족 일수의 올림이 같은 저회전 품목이 부족인데 권장 0 이 된다).
        //  목표(다음 요청분까지)로 재면 매주 정상 보충 품목까지 거의 늘 부족으로 뜬다 — 부족은 '지금 시켜도 늦는가'다.
        // 확정형 칸(프로모션·도매 대량)은 '목표만큼 늘 갖고 있는 칸'이 아니라 '요청수량을 채워
        //  나가는 칸'이라 목표 기반 부족 판정이 맞지 않는다(행사·발송 후 0 이 정상). 부족으로 세지 않는다(기획 2·5절).
        // 부족 = 그 칸 안에서만 본다. 프로모션 풀을 더하지 않는 것은 목표에서 행사 가산을 뺀 것과 짝이다(결정 9).
        // 도매 탭은 현재고만(2026-09-29 B안) — 도매 요청 잔여는 소매에 물건이 있어야 옮길 수 있어, 더하면 실제 재고 없음 위험이 가려진다.
        low: chan === "도매 대량" || chan === "프로모션" ? false : lead_safety > 0 && qty + (chan === "도매" ? 0 : inbQty) < lead_safety,
        is_bundle: isBundle,
      };
    });

    return NextResponse.json({ ok: true, rows, meta: { from, to, periodDays, leadDays, cycleDays, horizonDays, sellable, nextDraft, nextSellable, inboundOk, requestedOk, promosOk: promos.ok } });
  } catch (err) {
    console.error("[inventory/overview]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 개요 조회 실패") }, { status: 500 });
  }
}
