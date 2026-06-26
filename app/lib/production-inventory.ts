import { supabaseAdmin } from "./supabase";
import { fetchBoxheroItems } from "./boxhero";
import { getOrRefreshVelocity } from "./production-velocity";
import { getPromoQtyBySku } from "./production-promotions";
import { getSafetyAdjusts, effectiveDelta } from "./production-safety-adjust";

// 박스히어로 현재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 머지.
//  /api/production/inventory 와 생산 조언이 공유 — 숫자 일관성 유지.
//
// 안전재고는 박스히어로에 적힌 값을 쓰지 않고, 이 툴이 박스히어로 '출고 내역'으로 직접 산정한다.
//  안전재고 = 최근 하루 평균 출고량 × 생산 리드타임(LEAD_DAYS).
//  생산이 최소 LEAD_DAYS 걸린다고 보고, 그 기간 팔릴 만큼은 늘 쌓아두자는 의미(재고 쇼트 방지).

export const LEAD_DAYS = 10; // 생산 리드타임(일) — 최소 10일

export interface InvRow {
  sku: string;
  name: string;
  stock: number | null;   // 박스히어로 현재고 (null = 박스히어로에 없음)
  dailyOut: number;       // 최근 하루 평균 출고량 (박스히어로 출고 기준)
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

export async function getInventoryRows(token: string): Promise<InventoryResult> {
  // 1) 박스히어로 품목(현재고) — 안전재고는 더 이상 박스히어로 값을 쓰지 않음
  const items = await fetchBoxheroItems(token);
  const stockBySku = new Map<string, { name: string; stock: number }>();
  for (const it of items) {
    if (it.sku) stockBySku.set(it.sku.toUpperCase(), { name: it.name, stock: it.quantity });
  }

  // 1b) 판매속도(최근 출고 일평균) — 안전재고 산정 기준. 6시간 캐시.
  const velocity = await getOrRefreshVelocity(token);

  // 1c) 안전재고 보정: 프로모션 자동가산 + 수동 보정
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
  const [promoBySku, adjusts] = await Promise.all([
    getPromoQtyBySku(today, LEAD_DAYS),
    getSafetyAdjusts(),
  ]);

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
    const dailyOut = velocity.perSku[sku] || 0;
    const autoSafety = Math.ceil(dailyOut * LEAD_DAYS);
    const promoQty = promoBySku[sku] || 0;
    const adj = adjusts[sku];
    const adjust = effectiveDelta(adj, today);
    const safety = Math.max(0, autoSafety + promoQty + adjust); // 최종 안전재고
    const recommend = stock == null ? demand : Math.max(0, demand + safety - stock);
    const belowSafety = stock != null && stock < safety;
    rows.push({
      sku,
      name: st?.name || nameBySku.get(sku) || sku,
      stock,
      dailyOut,
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
      inBoxhero: !!st,
      inB2B: demand > 0,
    });
  }
  rows.sort((a, b) => b.recommend - a.recommend || Number(b.belowSafety) - Number(a.belowSafety) || a.sku.localeCompare(b.sku));

  return {
    rows,
    itemCount: items.length,
    noSkuDemand,
    leadDays: LEAD_DAYS,
    velocitySpanDays: velocity.spanDays,
    velocityCapped: velocity.capped,
  };
}
