import { supabaseAdmin } from "./supabase";
import { getLedgerVelocity } from "./production-velocity";
import { getPromoForwardBySku, getPromoSoldInWindow } from "./production-promotions";
import { getSafetyAdjusts, effectiveDelta, effectiveExclude } from "./production-safety-adjust";
import { getLeadDays, LINK_B2B_ORDERS_TO_PRODUCTION } from "./production-config";

// 자체 재고원장(inventory_txns) 현재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 머지.
//  /api/production/inventory 와 생산 조언이 공유 — 숫자 일관성 유지.
//  (2026-06 박스히어로 API 의존 제거 → 현재고·판매속도 모두 자체 원장 기준.)
//
// 안전재고 = 최근 하루 평균 출고량(원장 '출고') × 생산 리드타임(설정값, 기본 10일).
//  생산이 리드타임만큼 걸린다고 보고, 그 기간 팔릴 만큼은 늘 쌓아두자는 의미(재고 쇼트 방지).

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
}

export async function getInventoryRows(): Promise<InventoryResult> {
  const sb = supabaseAdmin();

  // 1) 자체 원장 현재고(품목당 1행 집계) + 제품표(sku·name) — 박스히어로 API 대신.
  const [stockRes, prodRes, velocity] = await Promise.all([
    sb.rpc("inventory_stock", { asof: null }),
    sb.from("products").select("id, sku, name"), // 전 품목(수요 매칭은 비활성 포함)
    getLedgerVelocity(), // 1b) 판매속도(최근 출고 일평균) — 원장 '출고' 전수 집계
  ]);
  if (stockRes.error) throw stockRes.error;
  if (prodRes.error) throw prodRes.error;

  const stockByProduct = new Map<string, number>();
  for (const t of (stockRes.data as { product_id: string; qty: number }[] | null) ?? []) stockByProduct.set(t.product_id, Number(t.qty) || 0);
  // SKU(대문자) → {name, stock}. 원장에 거래내역이 있는(=inventory_stock 에 잡히는) 제품만 현재고 보유.
  const stockBySku = new Map<string, { name: string; stock: number }>();
  for (const p of prodRes.data ?? []) {
    if (p.sku && stockByProduct.has(p.id)) stockBySku.set(String(p.sku).toUpperCase(), { name: p.name, stock: stockByProduct.get(p.id) || 0 });
  }

  // 1c) 안전재고 보정: 리드타임(설정) + 프로모션(스파이크 제거 + 남은 행사분) + 수동 보정
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
  const span = Math.max(1, velocity.spanDays);
  const wsD = new Date(today + "T00:00:00Z");
  wsD.setUTCDate(wsD.getUTCDate() - span); // 판매속도 집계창 시작(근사)
  const windowStart = wsD.toISOString().slice(0, 10);
  const leadDays = await getLeadDays(); // 생산 리드타임(설정값, 기본 10)
  const [promoForward, promoSold, adjusts] = await Promise.all([
    getPromoForwardBySku(today, leadDays),     // 앞으로 확보할 남은 행사분
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
    const autoSafety = Math.ceil(dailyOut * leadDays);
    const promoQty = Math.round(promoForward[sku] || 0);
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
      autoSafety,
      promoQty,
      adjust,
      adjustRaw: Math.round(Number(adj?.delta) || 0),
      adjustExcludeRaw: Math.max(0, Math.round(Number(adj?.excludeOut) || 0)),
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
    itemCount: stockBySku.size,
    noSkuDemand,
    leadDays,
    velocitySpanDays: velocity.spanDays,
    velocityCapped: velocity.capped,
  };
}
