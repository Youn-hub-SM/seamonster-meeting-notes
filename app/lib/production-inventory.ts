import { supabaseAdmin } from "./supabase";
import { fetchBoxheroItems } from "./boxhero";
import { getOrRefreshVelocity } from "./production-velocity";
import { getPromoForwardBySku, getPromoSoldInWindow } from "./production-promotions";
import { getSafetyAdjusts, effectiveDelta } from "./production-safety-adjust";
import { getLeadDays, getDemixEnabled, getDemixSkus, getDemixFactor } from "./production-config";
import { getB2bShippedInWindow } from "./production-b2b-shipments";

// 박스히어로 현재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 머지.
//  /api/production/inventory 와 생산 조언이 공유 — 숫자 일관성 유지.
//
// 안전재고는 박스히어로에 적힌 값을 쓰지 않고, 이 툴이 박스히어로 '출고 내역'으로 직접 산정한다.
//  안전재고 = 최근 하루 평균 출고량 × 생산 리드타임(설정값, 기본 10일).
//  생산이 리드타임만큼 걸린다고 보고, 그 기간 팔릴 만큼은 늘 쌓아두자는 의미(재고 쇼트 방지).

export interface InvRow {
  sku: string;
  name: string;
  stock: number | null;   // 박스히어로 현재고 (null = 박스히어로에 없음)
  dailyOut: number;       // 행사·도매 제거한 평상시(소매) 하루 평균 출고량
  rawDailyOut: number;    // 보정 전 원 출고 일평균(참고)
  boxheroOutQty: number;  // 집계창 BoxHero 총출고(근사 = rawDailyOut × span) — 근거 대조용
  b2bShippedQty: number;  // 집계창 B2B 발송완료 합(도매) — 근거 대조용
  wholesaleSoldQty: number; // 실제 차감한 도매분(= b2bShipped × factor, demix 적용 시만)
  demixApplied: boolean;  // 이 SKU에 de-mix(도매 차감)가 적용됐는지
  demixClampedToZero: boolean; // 도매 차감으로 소매속도가 0으로 눌린 경우(레이더 실종 경고)
  autoSafety: number;     // 자동 안전재고 = ceil(dailyOut × LEAD_DAYS)
  promoQty: number;       // 프로모션 자동 가산(리드타임 내 행사)
  adjust: number;         // 수동 보정(만료 반영된 유효값)
  adjustRaw: number;      // 저장된 보정값(만료 무관 — 편집용)
  adjustMemo: string;     // 보정 사유
  adjustUntil: string | null; // 보정 만료일
  safety: number;         // 최종 안전재고 = max(0, autoSafety + promoQty + adjust)
  demand: number;         // B2B 생산대기·생산중 수요
  recommend: number;      // 권장 생산량 = max(0, 수요 + 안전재고 − 현재고)
  belowSafety: boolean;
  requestByDays: number | null; // 생산요청 마감까지 남은 일수(0·음수=지금/이미 늦음). 출고0·재고없음이면 null
  requestBy: string | null;     // 생산요청 마감일(YYYY-MM-DD, 미래일 때만). 현재고가 안전재고로 떨어지는 날
  inBoxhero: boolean;
  inB2B: boolean;
}

export interface InventoryResult {
  rows: InvRow[];
  itemCount: number;
  noSkuDemand: number;
  leadDays: number;          // 안전재고 산정에 쓴 리드타임
  velocitySpanDays: number;  // 출고 평균이 커버한 일수
  velocityCapped: boolean;   // 표본 상한에 걸려 일부만 집계했는지
  demixEnabled: boolean;     // 도매 de-mix 켜짐 여부
  demixFactor: number;       // 도매 차감 계수(0~1)
  demixActive: boolean;      // 이번 산정에 실제 de-mix가 적용됐는지(켜짐+미capped+화이트리스트有)
  demixUnresolvedQty: number;// SKU 못 푼 B2B 발송분(차감 누락)
}

export async function getInventoryRows(token: string): Promise<InventoryResult> {
  // 1) 박스히어로 품목(현재고) — 안전재고는 더 이상 박스히어로 값을 쓰지 않음
  const items = await fetchBoxheroItems(token);
  const stockBySku = new Map<string, { name: string; stock: number }>();
  for (const it of items) {
    if (it.sku) stockBySku.set(it.sku.toUpperCase(), { name: it.name, stock: it.quantity });
  }

  // 1b) 판매속도(최근 출고 일평균) — 안전재고 산정 기준. 6시간 캐시.
  const velocity = await getOrRefreshVelocity(token);

  // 1c) 안전재고 보정: 리드타임(설정) + 프로모션(스파이크 제거 + 남은 행사분) + 수동 보정
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
  const span = Math.max(1, velocity.spanDays);
  const wsD = new Date(today + "T00:00:00Z");
  wsD.setUTCDate(wsD.getUTCDate() - span); // 판매속도 집계창 시작(근사)
  const windowStart = wsD.toISOString().slice(0, 10);
  const leadDays = await getLeadDays(); // 생산 리드타임(설정값, 기본 10)
  const [promoForward, promoSold, adjusts, demixEnabled, demixSkus, demixFactor, b2bShipped] = await Promise.all([
    getPromoForwardBySku(today, leadDays),     // 앞으로 확보할 남은 행사분
    getPromoSoldInWindow(windowStart, today),  // 집계창에 이미 나간 행사분(속도에서 제거)
    getSafetyAdjusts(),
    getDemixEnabled(),
    getDemixSkus(),
    getDemixFactor(),
    getB2bShippedInWindow(windowStart, today), // 집계창 B2B 발송완료(과거 도매 출고) — 근거 대조 + de-mix
  ]);
  const demixSkuSet = new Set(demixSkus);
  // de-mix 적용 조건: 켜짐 + 화이트리스트. (capped는 집계창을 짧게 줄일 뿐 그 창 안에선
  //  가장 최근 트랜잭션이 전수라 부분표본이 아님 — velocity·b2bShipped 둘 다 같은 창이라 정합.
  //  과차감 방지는 under-subtract 계수(factor)와 화이트리스트로 처리.)
  const demixActive = demixEnabled && demixSkuSet.size > 0;

  const sb = supabaseAdmin();

  // 2) 제품표: product_id → sku / name
  const { data: products, error: pErr } = await sb.from("products").select("id, sku, name");
  if (pErr) throw pErr;
  const skuByProduct = new Map<string, string>();
  const nameBySku = new Map<string, string>();
  for (const p of products ?? []) {
    if (p.sku) {
      skuByProduct.set(p.id, p.sku);
      const k = String(p.sku).toUpperCase();
      if (!nameBySku.has(k)) nameBySku.set(k, p.name);
    }
  }

  // 3) B2B 수요: 생산대기·생산중 발주 라인아이템 합 (SKU 기준)
  const { data: orders, error: oErr } = await sb
    .from("orders")
    .select("id, production_status, order_items(product_id, qty)")
    .in("production_status", ["생산대기", "생산중"]);
  if (oErr) throw oErr;

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
    const boxheroOutQty = Math.round(rawDailyOut * span);          // 창내 BoxHero 총출고(근사) — 근거 대조
    const b2bShippedQty = Math.round(b2bShipped.bySku[sku] || 0);  // 창내 B2B 발송완료(도매) — 근거 대조
    const demixApplied = demixActive && demixSkuSet.has(sku);
    const wholesaleSold = demixApplied ? (b2bShipped.bySku[sku] || 0) * demixFactor : 0; // 실제 차감할 도매분(계수 적용)
    const afterPromo = rawDailyOut - (promoSold[sku] || 0) / span;
    const dailyOut = Math.max(0, afterPromo - wholesaleSold / span); // 행사·도매 제거한 평상시(소매) 일평균
    const demixClampedToZero = demixApplied && afterPromo > 0.05 && dailyOut < 0.05; // 도매 차감으로 소매속도 무시가능 수준(레이더 실종)
    const autoSafety = Math.ceil(dailyOut * leadDays);
    const promoQty = Math.round(promoForward[sku] || 0);
    const adj = adjusts[sku];
    const adjust = effectiveDelta(adj, today);
    const safety = Math.max(0, autoSafety + promoQty + adjust); // 최종 안전재고
    const recommend = stock == null ? demand : Math.max(0, demand + safety - stock);
    const belowSafety = stock != null && stock < safety;
    // 생산요청 마감일 = 현재고가 안전재고 수준으로 떨어지는 날(= 리드타임만큼 앞당긴 시점).
    //  이 날을 넘기면 안전재고 밑으로 → 리드타임 안에 못 만들어 쇼트 위험.
    let requestByDays: number | null = null;
    let requestBy: string | null = null;
    if (stock != null && dailyOut > 0) {
      requestByDays = Math.floor((stock - safety) / dailyOut);
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
      boxheroOutQty,
      b2bShippedQty,
      wholesaleSoldQty: Math.round(wholesaleSold),
      demixApplied,
      demixClampedToZero,
      autoSafety,
      promoQty,
      adjust,
      adjustRaw: Math.round(Number(adj?.delta) || 0),
      adjustMemo: adj?.memo || "",
      adjustUntil: adj?.until || null,
      safety,
      demand,
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
    itemCount: items.length,
    noSkuDemand,
    leadDays,
    velocitySpanDays: velocity.spanDays,
    velocityCapped: velocity.capped,
    demixEnabled,
    demixFactor,
    demixActive,
    demixUnresolvedQty: b2bShipped.unresolvedQty,
  };
}
