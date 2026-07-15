import type { supabaseAdmin } from "./supabase";

export type BundleComponent = { component_id: string; qty: number };

// 부모 product_id → 구성품 목록. 037 미적용(테이블 없음)이면 빈 맵.
export async function getAllBundles(sb: ReturnType<typeof supabaseAdmin>): Promise<Map<string, BundleComponent[]>> {
  const m = new Map<string, BundleComponent[]>();
  const res = await sb.from("product_bundles").select("parent_id, component_id, qty");
  if (res.error) return m; // 테이블 없음 등 → 묶음 기능 비활성
  for (const r of (res.data as { parent_id: string; component_id: string; qty: number }[] | null) ?? []) {
    const q = Math.max(1, Math.round(Number(r.qty) || 1));
    m.set(r.parent_id, [...(m.get(r.parent_id) || []), { component_id: r.component_id, qty: q }]);
  }
  return m;
}

// 이 품목이 묶음인가 — 구성품이 하나라도 있으면 묶음(= 자체 재고가 없음).
export function isBundleId(bundles: Map<string, BundleComponent[]>, productId: string): boolean {
  return (bundles.get(productId)?.length ?? 0) > 0;
}

// 묶음 → 구성품 재귀 전개(중첩 묶음 포함). 묶음이 아니면 자기 자신. 반환: product_id → 수량(양수).
//  묶음은 자체 재고가 없고 현재고를 구성품에서 파생하므로, 원장은 반드시 구성품으로 남겨야 한다.
//  모든 입고/출고 경로(소매 출고·B2B 발송·재고 구매및판매·엑셀 업로드)가 이 한 규칙만 쓴다 —
//  경로마다 따로 구현하면 같은 판매가 경로에 따라 다르게 차감된다.
export function expandBundleQty(
  bundles: Map<string, BundleComponent[]>,
  productId: string,
  qty: number,
  into: Map<string, number> = new Map(),
  depth = 0
): Map<string, number> {
  const comps = bundles.get(productId);
  if (comps && comps.length > 0 && depth < 8) {
    for (const c of comps) expandBundleQty(bundles, c.component_id, qty * c.qty, into, depth + 1);
  } else {
    into.set(productId, (into.get(productId) || 0) + qty);
  }
  return into;
}

// 한 세트를 만들 수 있는 수량 = min( 구성품 현재고 ÷ 구성수량 ). 구성품 없으면 0.
export function bundleAvailable(components: BundleComponent[], stockOf: (id: string) => number): number {
  if (!components.length) return 0;
  return Math.min(...components.map((c) => Math.floor((stockOf(c.component_id) || 0) / c.qty)));
}
