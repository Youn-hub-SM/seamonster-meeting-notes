import { supabaseAdmin } from "./supabase";
import { fetchBoxheroItems } from "./boxhero";

// 박스히어로 재고·안전재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 머지.
//  /api/production/inventory 와 생산 조언이 공유 — 숫자 일관성 유지.

export interface InvRow {
  sku: string;
  name: string;
  stock: number | null;   // 박스히어로 현재고 (null = 박스히어로에 없음)
  safety: number | null;  // 안전재고
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
}

export async function getInventoryRows(token: string): Promise<InventoryResult> {
  // 1) 박스히어로 품목(현재고·안전재고)
  const items = await fetchBoxheroItems(token);
  const stockBySku = new Map<string, { name: string; stock: number; safety: number | null }>();
  for (const it of items) {
    if (it.sku) stockBySku.set(it.sku.toUpperCase(), { name: it.name, stock: it.quantity, safety: it.safety });
  }

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
    const safety = st ? st.safety : null;
    const recommend = stock == null ? demand : Math.max(0, demand + (safety || 0) - stock);
    const belowSafety = stock != null && safety != null && stock < safety;
    rows.push({
      sku,
      name: st?.name || nameBySku.get(sku) || sku,
      stock,
      safety,
      demand,
      recommend,
      belowSafety,
      inBoxhero: !!st,
      inB2B: demand > 0,
    });
  }
  rows.sort((a, b) => b.recommend - a.recommend || Number(b.belowSafety) - Number(a.belowSafety) || a.sku.localeCompare(b.sku));

  return { rows, itemCount: items.length, noSkuDemand };
}
