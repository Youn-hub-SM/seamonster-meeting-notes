import { supabaseAdmin } from "./supabase";
import { getLedgerVelocity } from "./production-velocity";
import { getPromoForwardBySku, getPromoSoldInWindow } from "./production-promotions";
import { getSafetyAdjusts, effectiveDelta, effectiveExclude } from "./production-safety-adjust";
import { getLeadDays, getCycleDays, LINK_B2B_ORDERS_TO_PRODUCTION } from "./production-config";
import { getOpenInboundByProduct, type InboundRow } from "./production-inbound";

// 자체 재고원장(inventory_txns) 현재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 머지.
//  /api/production/inventory 와 생산 조언이 공유 — 숫자 일관성 유지.
//  (2026-06 박스히어로 API 의존 제거 → 현재고·판매속도 모두 자체 원장 기준.)
//
// 안전재고 = 최근 하루 평균 출고량(원장 '출고') × (생산 리드타임 + 발주 주기)(설정값).
//  생산이 리드타임만큼 걸린다고 보고, 그 기간(+다음 발주까지) 팔릴 만큼은 늘 쌓아두자는 의미(재고 쇼트 방지).
// 권장 생산량 = max(0, 수요 + 안전재고 − (현재고 + 입고 예정)) — '입고 예정'은 열린 제조사 요청서의 잔여
//  (production-inbound). 시켜 둔 물량을 또 시키던 이중 발주의 차단 항(2026-09-17 대표 확정 1단계).

export interface InvRow {
  sku: string;
  name: string;
  stock: number | null;   // 현재고 (null = 원장에 거래내역 없음)
  dailyOut: number;       // 행사 제거한 평상시 하루 평균 출고량
  rawDailyOut: number;    // 보정 전 원 출고 일평균(참고)
  autoSafety: number;     // 자동 안전재고 = ceil(dailyOut × LEAD_DAYS)
  promoQty: number;       // 프로모션 자동 가산(리드타임 내 행사)
  adjust: number;         // 추가 확보(만료 반영된 유효 delta)
  adjustRaw: number;      // 저장된 추가확보값(만료 무관 — 편집용)
  adjustExcludeRaw: number; // 저장된 '행사 출고 빼기' 양(만료 무관 — 편집용)
  adjustMemo: string;     // 보정 사유
  adjustUntil: string | null; // 보정 만료일
  safety: number;         // 최종 안전재고 = max(0, autoSafety + promoQty + adjust)
  demand: number;         // B2B 생산대기·생산중 수요
  inbound: number;        // 입고 예정 = 열린 제조사 요청서 잔여(소매·전체 수식만, 도매 수식은 0)
  inboundDue: string | null;    // 잔여가 있는 요청서 중 가장 이른 마감
  inboundOverdue: number;       // 그중 마감이 지난 잔여(자동 제외 없음 — 표시용)
  recommend: number;      // 권장 생산량 = max(0, 수요 + 안전재고 − (현재고 + 입고 예정))
  belowSafety: boolean;   // 현재고 + 입고 예정 < 안전재고 (권장과 같은 포지션 기준)
  requestByDays: number | null; // 생산요청 마감까지 남은 일수(0·음수=지금/이미 늦음). 출고0·재고없음이면 null
  requestBy: string | null;     // 생산요청 마감일(YYYY-MM-DD, 미래일 때만). 현재고+입고 예정이 안전재고로 떨어지는 날
  inBoxhero: boolean;
  inB2B: boolean;
}

export interface InventoryResult {
  rows: InvRow[];
  itemCount: number;
  noSkuDemand: number;
  leadDays: number;          // 안전재고 산정에 쓴 리드타임
  cycleDays: number;         // 발주 주기(설정, 기본 0)
  horizonDays: number;       // 안전재고 지평 = 리드타임 + 발주 주기
  inboundOk: boolean;        // 입고 예정 집계 성공 여부 — false 면 권장이 실제보다 클 수 있다(화면이 경고)
  velocitySpanDays: number;  // 출고 평균이 커버한 일수
  velocityCapped: boolean;   // 표본 상한에 걸려 일부만 집계했는지
}

// channel 미지정 = 전체 재고·레거시 속도(기존 소비처 호환). "소매"/"도매" = 그 채널의 재고·소진 속도만.
//  도매 조언 수식 = 소매와 동일 구조(안전재고 = 하루 소진 × 리드타임)를 도매 데이터로 계산.
//  단 행사(프로모션)·수동 보정은 소매 판매 보정 장치라 도매 채널에는 적용하지 않는다(순수 수식).
export async function getInventoryRows(channel?: "소매" | "도매"): Promise<InventoryResult> {
  const sb = supabaseAdmin();

  // 1) 자체 원장 현재고(품목당 1행 집계) + 제품표(sku·name) — 박스히어로 API 대신.
  const stockRpc = async () => {
    if (channel) {
      const r = await sb.rpc("inventory_stock", { asof: null, chan: channel });
      if (!r.error) return r;
      // 036 미적용 폴백 — 채널 구분 없이 전체
    }
    return sb.rpc("inventory_stock", { asof: null });
  };
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
  // 입고 예정 — 제조사 생산 입고는 소매 채널로 들어오므로 소매·전체 수식에서만 뺀다.
  //  도매 수식의 부족은 소매→도매 이동으로 채워지는 몫이라 제조사 잔여를 빼면 이중 차감이 된다.
  //  가장 무거운 원장 속도 조회와 나란히 돌려 지연을 숨긴다.
  const [stockRes, prodRes, velocity, inboundByProduct] = await Promise.all([
    stockRpc(),
    sb.from("products").select("id, sku, name"), // 전 품목(수요 매칭은 비활성 포함)
    getLedgerVelocity(undefined, channel), // 1b) 소진 속도(최근 출고 일평균) — 채널별
    channel === "도매" ? Promise.resolve(new Map<string, InboundRow>()) : getOpenInboundByProduct(sb, today),
  ]);
  const inboundOk = inboundByProduct !== null;
  if (stockRes.error) throw stockRes.error;
  if (prodRes.error) throw prodRes.error;

  const stockByProduct = new Map<string, number>();
  for (const t of (stockRes.data as { product_id: string; qty: number }[] | null) ?? []) stockByProduct.set(t.product_id, Number(t.qty) || 0);
  // 프로모션 풀 합산(113) — 소매 수식의 현재고에 프로모션 확보분을 포함한다. 행사 수요는 안전재고의
  //  프로모션 일정 보정(promoForward)에 이미 들어 있고, 풀로 옮겨둔 확보분이 그 수요를 채우는 재고다.
  //  합산하지 않으면 풀로 옮기는 즉시 소매 현재고가 줄어 권장이 다시 부풀고 이중 생산을 시킨다.
  //  (전체(channel 미지정)는 chan null 조회가 전 풀 합산이라 이미 포함, 도매 수식은 무관)
  if (channel === "소매") {
    try {
      const pr = await sb.rpc("inventory_stock", { asof: null, chan: "프로모션" });
      if (!pr.error) {
        for (const t of (pr.data as { product_id: string; qty: number }[] | null) ?? []) {
          stockByProduct.set(t.product_id, (stockByProduct.get(t.product_id) || 0) + (Number(t.qty) || 0));
        }
      }
    } catch { /* 113 미적용 등 — 소매 단독으로 진행 */ }
  }
  // SKU(대문자) → {name, stock}. 원장에 거래내역이 있는(=inventory_stock 에 잡히는) 제품만 현재고 보유.
  const stockBySku = new Map<string, { name: string; stock: number }>();
  for (const p of prodRes.data ?? []) {
    if (p.sku && stockByProduct.has(p.id)) stockBySku.set(String(p.sku).toUpperCase(), { name: p.name, stock: stockByProduct.get(p.id) || 0 });
  }

  // 1c) 안전재고 보정: 리드타임(설정) + 프로모션(스파이크 제거 + 남은 행사분) + 수동 보정
  const span = Math.max(1, velocity.spanDays);
  const wsD = new Date(today + "T00:00:00Z");
  wsD.setUTCDate(wsD.getUTCDate() - span); // 판매속도 집계창 시작(근사)
  const windowStart = wsD.toISOString().slice(0, 10);
  const [leadDays, cycleDays] = await Promise.all([getLeadDays(), getCycleDays()]); // 생산 리드타임(기본 7) + 발주 주기(기본 0)
  const horizonDays = leadDays + cycleDays; // 안전재고 지평
  const wholesale = channel === "도매"; // 행사·수동 보정은 소매 판매 장치 — 도매 수식에는 미적용
  const [promoForward, promoSold, adjusts] = wholesale
    ? [{} as Record<string, number>, {} as Record<string, number>, {} as Awaited<ReturnType<typeof getSafetyAdjusts>>]
    : await Promise.all([
        getPromoForwardBySku(today, horizonDays),  // 앞으로 확보할 남은 행사분(지평 = 리드타임 + 발주 주기)
        getPromoSoldInWindow(windowStart, today),  // 집계창에 이미 나간 행사분(속도에서 제거)
        getSafetyAdjusts(),
      ]);
  // 2) 제품표: product_id → sku / name (위에서 받은 prodRes 재사용)
  const skuByProduct = new Map<string, string>();
  const nameBySku = new Map<string, string>();
  for (const p of prodRes.data ?? []) {
    if (p.sku) {
      skuByProduct.set(p.id, p.sku);
      const k = String(p.sku).toUpperCase();
      if (!nameBySku.has(k)) nameBySku.set(k, p.name);
    }
  }

  // 3) B2B 수요: 생산대기·생산중 발주 라인아이템 합 (SKU 기준).
  //  재고 생산을 별도 운영하면(플래그 off) B2B 수요는 재고 조언 계산에서 제외.
  const { data: orders, error: oErr } = LINK_B2B_ORDERS_TO_PRODUCTION
    ? await sb.from("orders").select("id, production_status, order_items(product_id, qty)").in("production_status", ["생산대기", "생산중"])
    : { data: [] as unknown, error: null };
  if (oErr) throw oErr;

  // 입고 예정을 SKU 로 합산(중복 SKU 는 수요와 같은 규칙으로 합쳐진다)
  const inboundBySku = new Map<string, { qty: number; due: string | null; overdue: number }>();
  for (const [pid, row] of inboundByProduct ?? new Map<string, InboundRow>()) {
    const sku = skuByProduct.get(pid);
    if (!sku) continue;
    const k = sku.toUpperCase();
    const cur = inboundBySku.get(k) ?? { qty: 0, due: null, overdue: 0 };
    cur.qty = Math.round((cur.qty + row.qty) * 100) / 100;
    cur.overdue = Math.round((cur.overdue + row.overdue_qty) * 100) / 100;
    if (row.earliest_due && (!cur.due || row.earliest_due < cur.due)) cur.due = row.earliest_due;
    inboundBySku.set(k, cur);
  }

  const demandBySku = new Map<string, number>();
  let noSkuDemand = 0;
  type OItem = { product_id: string | null; qty: number };
  for (const o of (orders ?? []) as unknown as { order_items: OItem[] }[]) {
    for (const it of o.order_items ?? []) {
      const sku = it.product_id ? skuByProduct.get(it.product_id) : null;
      const qty = Number(it.qty) || 0;
      if (sku) {
        const k = sku.toUpperCase();
        demandBySku.set(k, (demandBySku.get(k) || 0) + qty);
      } else {
        noSkuDemand += qty;
      }
    }
  }

  // 4) SKU 합집합으로 행 구성
  const allSkus = new Set<string>([...stockBySku.keys(), ...demandBySku.keys()]);
  const rows: InvRow[] = [];
  for (const sku of allSkus) {
    const st = stockBySku.get(sku);
    const demand = demandBySku.get(sku) || 0;
    const stock = st ? st.stock : null;
    const rawDailyOut = velocity.perSku[sku] || 0;
    const adj = adjusts[sku];
    const manualExclude = effectiveExclude(adj, today); // 사용자가 '행사 출고'로 빼라고 한 양
    const dailyOut = Math.max(0, rawDailyOut - (promoSold[sku] || 0) / span - manualExclude / span); // 행사·수동행사 제거한 평상시 일평균
    const autoSafety = Math.ceil(dailyOut * horizonDays);
    const promoQty = Math.round(promoForward[sku] || 0);
    const adjust = effectiveDelta(adj, today);
    const safety = Math.max(0, autoSafety + promoQty + adjust); // 최종 안전재고
    const inb = inboundBySku.get(sku);
    const inbound = inb?.qty ?? 0;
    // 권장 = 수요 + 안전재고 − (현재고 + 입고 예정). 시켜 둔 물량(입고 예정)이 도착해 현재고로 옮겨 가도 합은 그대로라
    //  권장이 튀지 않는다(불변식). 원장 기록이 없는 품목은 종전대로 수요만.
    const recommend = stock == null ? demand : Math.max(0, demand + safety - (stock + inbound));
    const belowSafety = stock != null && stock + inbound < safety; // 권장·주문필요와 같은 포지션(현재고+입고 예정) 기준

    // 생산요청 마감일 = 현재고+입고 예정이 안전재고 수준으로 떨어지는 날(= 리드타임만큼 앞당긴 시점).
    //  이 날을 넘기면 안전재고 밑으로 → 리드타임 안에 못 만들어 쇼트 위험.
    let requestByDays: number | null = null;
    let requestBy: string | null = null;
    if (stock != null && dailyOut > 0) {
      requestByDays = Math.floor((stock + inbound - safety) / dailyOut);
      if (requestByDays > 0) {
        const rd = new Date(today + "T00:00:00Z");
        rd.setUTCDate(rd.getUTCDate() + requestByDays);
        requestBy = rd.toISOString().slice(0, 10);
      }
    }
    rows.push({
      sku,
      name: st?.name || nameBySku.get(sku) || sku,
      stock,
      dailyOut,
      rawDailyOut,
      autoSafety,
      promoQty,
      adjust,
      adjustRaw: Math.round(Number(adj?.delta) || 0),
      adjustExcludeRaw: Math.max(0, Math.round(Number(adj?.excludeOut) || 0)),
      adjustMemo: adj?.memo || "",
      adjustUntil: adj?.until || null,
      safety,
      demand,
      inbound,
      inboundDue: inb?.due ?? null,
      inboundOverdue: inb?.overdue ?? 0,
      recommend,
      belowSafety,
      requestByDays,
      requestBy,
      inBoxhero: !!st,
      inB2B: demand > 0,
    });
  }
  rows.sort((a, b) => b.recommend - a.recommend || Number(b.belowSafety) - Number(a.belowSafety) || a.sku.localeCompare(b.sku));

  return {
    rows,
    itemCount: stockBySku.size,
    noSkuDemand,
    leadDays,
    cycleDays,
    horizonDays,
    inboundOk,
    velocitySpanDays: velocity.spanDays,
    velocityCapped: velocity.capped,
  };
}
