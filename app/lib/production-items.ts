import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 생산 품목 묶음 — 생산에서는 '품목명'이 아니라 'SKU'로 묶는다. (같은 제품 = 같은 SKU)
//  073부터 SKU 는 유일(upper 기준)이라 그룹은 사실상 1행이지만,
//  미적용 환경·과거 데이터 호환을 위해 최단 이름 대표명 선출은 유지.
// ─────────────────────────────────────────────

export interface ProdItemMaps {
  skuByProduct: Map<string, string>; // product_id → SKU(대문자)
  displayBySku: Map<string, string>; // SKU(대문자) → 생산 표시명
}

export async function loadProdItemMaps(): Promise<ProdItemMaps> {
  const sb = supabaseAdmin();
  const { data: products } = await sb.from("products").select("id, sku, name");
  const skuByProduct = new Map<string, string>();
  const names = new Map<string, string[]>();
  for (const p of products ?? []) {
    if (!p.sku) continue;
    const k = String(p.sku).toUpperCase();
    skuByProduct.set(p.id, k);
    const arr = names.get(k) || [];
    arr.push(p.name);
    names.set(k, arr);
  }
  const displayBySku = new Map<string, string>();
  for (const [sku, arr] of names) {
    displayBySku.set(sku, arr.slice().sort((a, b) => a.length - b.length)[0]);
  }
  return { skuByProduct, displayBySku };
}
