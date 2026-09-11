import type { supabaseAdmin } from "./supabase";

export type BundleComponent = { component_id: string; qty: number };

// 부모 product_id → 구성품 목록. 037 미적용(테이블 없음)이면 빈 맵.
//  단발 select 는 서버 Max Rows(기본 1000)에 조용히 잘린다 — 구성 행이 늘어나면 전개·순환검증이
//  누락 간선 위에서 돌게 되므로 range 페이징으로 전량 읽는다(판매속도 lib 와 동일 패턴).
export async function getAllBundles(sb: ReturnType<typeof supabaseAdmin>): Promise<Map<string, BundleComponent[]>> {
  const m = new Map<string, BundleComponent[]>();
  for (let i = 0; i < 100000; i += 1000) {
    const res = await sb.from("product_bundles").select("parent_id, component_id, qty")
      .order("parent_id", { ascending: true }).order("component_id", { ascending: true })
      .range(i, i + 999);
    if (res.error) return m; // 테이블 없음 등 → 묶음 기능 비활성
    const rows = (res.data as { parent_id: string; component_id: string; qty: number }[] | null) ?? [];
    for (const r of rows) {
      const q = Math.max(1, Math.round(Number(r.qty) || 1));
      m.set(r.parent_id, [...(m.get(r.parent_id) || []), { component_id: r.component_id, qty: q }]);
    }
    if (rows.length < 1000) break;
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
  depth = 0,
  path: Set<string> = new Set()
): Map<string, number> {
  const comps = bundles.get(productId);
  if (comps && comps.length > 0) {
    // 순환(A⊃B⊃A)·과다 중첩 가드 — 종전엔 depth 한계에서 '묶음 id'가 배수 누적 수량으로 원장에
    //  기록돼 재고 미차감+원장 오염이 됐다(감사 확정). 묶음 id 는 어떤 경우에도 원장에 남기지 않는다.
    if (path.has(productId) || depth >= 8) {
      // 무증상 폐기 방지 — 이 가지의 수량은 어떤 원장에도 안 남으므로 서버 로그에는 흔적을 남긴다
      console.error(`[product-bundles] 묶음 순환/과다중첩으로 전개 중단: ${productId} (qty ${qty}) — 구성 확인 필요`);
      return into;
    }
    path.add(productId);
    for (const c of comps) expandBundleQty(bundles, c.component_id, qty * c.qty, into, depth + 1, path);
    path.delete(productId);
  } else {
    into.set(productId, (into.get(productId) || 0) + qty);
  }
  return into;
}

// parent 에 이 구성품들을 저장하면 순환(A⊃B⊃A)이 생기는가 — 저장 전 검증용.
//  순환이 저장되면 전개 가드가 그 가지를 통째로 버려 재고가 차감되지 않으므로 등록 자체를 막는다.
export function wouldCreateCycle(
  bundles: Map<string, BundleComponent[]>,
  parentId: string,
  componentIds: string[]
): boolean {
  const next = new Map(bundles);
  next.set(parentId, componentIds.map((id) => ({ component_id: id, qty: 1 })));
  const visit = (id: string, path: Set<string>): boolean => {
    if (path.has(id)) return true;
    const comps = next.get(id);
    if (!comps || comps.length === 0) return false;
    path.add(id);
    for (const c of comps) if (visit(c.component_id, path)) return true;
    path.delete(id);
    return false;
  };
  return visit(parentId, new Set());
}

// 한 세트를 만들 수 있는 수량 = min( 구성품 현재고 ÷ 구성수량 ). 구성품 없으면 0.
export function bundleAvailable(components: BundleComponent[], stockOf: (id: string) => number): number {
  if (!components.length) return 0;
  return Math.min(...components.map((c) => Math.floor((stockOf(c.component_id) || 0) / c.qty)));
}
