import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 생산 품목 묶음 — B2B는 단가 때문에 같은 제품도 업체별로 다른 품목명을 쓰므로,
//  생산에서는 '품목명'이 아니라 'SKU'로 묶는다. (같은 제품 = 같은 SKU)
//  화면에 보일 '생산 표시명'은 b2b_settings('production_item_alias') 에서 SKU별로 조정.
// ─────────────────────────────────────────────

const ALIAS_KEY = "production_item_alias";

export async function getProductionAliases(): Promise<Record<string, string>> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", ALIAS_KEY).maybeSingle();
    const v = data?.value;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function setProductionAlias(sku: string, name: string): Promise<Record<string, string>> {
  const sb = supabaseAdmin();
  const cur = await getProductionAliases();
  const key = (sku || "").trim().toUpperCase();
  if (!key) return cur;
  const clean = (name || "").trim();
  if (clean) cur[key] = clean;
  else delete cur[key];
  await sb.from("b2b_settings").upsert(
    { key: ALIAS_KEY, value: cur, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return cur;
}

export interface ProdItemMaps {
  skuByProduct: Map<string, string>; // product_id → SKU(대문자)
  displayBySku: Map<string, string>; // SKU(대문자) → 생산 표시명 (alias > 대표명)
  aliases: Record<string, string>;
}

// products + alias 로부터 매핑 구성. 대표명 = 같은 SKU 제품명 중 가장 짧은 것(채널 접미사 제거 효과).
export async function loadProdItemMaps(): Promise<ProdItemMaps> {
  const sb = supabaseAdmin();
  const [{ data: products }, aliases] = await Promise.all([
    sb.from("products").select("id, sku, name"),
    getProductionAliases(),
  ]);
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
    const canonical = arr.slice().sort((a, b) => a.length - b.length)[0];
    displayBySku.set(sku, aliases[sku] || canonical);
  }
  return { skuByProduct, displayBySku, aliases };
}
