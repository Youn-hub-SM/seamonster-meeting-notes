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

// 한 세트를 만들 수 있는 수량 = min( 구성품 현재고 ÷ 구성수량 ). 구성품 없으면 0.
export function bundleAvailable(components: BundleComponent[], stockOf: (id: string) => number): number {
  if (!components.length) return 0;
  return Math.min(...components.map((c) => Math.floor((stockOf(c.component_id) || 0) / c.qty)));
}
