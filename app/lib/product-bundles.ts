import type { supabaseAdmin } from "./supabase";

export type BundleComponent = { component_id: string; qty: number };

// 부모 product_id → 구성품 목록. 037 미적용(테이블 없음)이면 빈 맵.
//  단발 select 는 서버 Max Rows(기본 1000)에 조용히 잘린다 — 구성 행이 늘어나면 전개·순환검증이
//  누락 간선 위에서 돌게 되므로 range 페이징으로 전량 읽는다(판매속도 lib 와 동일 패턴).
//  그 밖의 조회 오류는 던진다(docs/ledger-standard.md S4) — 일시 오류를 '세트 없음'으로 보면 세트 출고가
//  세트 id 로 기록되고 구성품은 안 빠진다. 부르는 쪽은 오류로 멈추고 다시 시도하게 한다.
export const bundlesTableMissing = (e: { code?: string; message?: string }) =>
  e.code === "42P01" || e.code === "PGRST205" || (/product_bundles/i.test(e.message || "") && /does not exist|schema cache|could not find/i.test(e.message || ""));
export async function getAllBundles(sb: ReturnType<typeof supabaseAdmin>): Promise<Map<string, BundleComponent[]>> {
  const m = new Map<string, BundleComponent[]>();
  for (let i = 0; i < 100000; i += 1000) {
    const res = await sb.from("product_bundles").select("parent_id, component_id, qty")
      .order("parent_id", { ascending: true }).order("component_id", { ascending: true })
      .range(i, i + 999);
    if (res.error) {
      if (bundlesTableMissing(res.error)) return m; // 037 미적용 → 묶음 기능 비활성
      throw new Error(`세트 구성을 읽지 못했습니다(${res.error.message}) — 잠시 뒤 다시 시도하세요.`);
    }
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

// 세트 구성 전체 교체 — 모든 저장 경로(묶음 엑셀·직접 추가·상품 마스터 구성 편집)가 이 함수만 쓴다(S3).
//  131 RPC replace_bundle: 검증·순환 검사·삭제·넣기가 한 트랜잭션 — 실패하면 기존 구성이 그대로 남는다.
//  RPC 미적용이면 upsert → 빠진 구성만 삭제 순서로 폴백한다. 종전 '전부 삭제 → 넣기'는 넣기가 실패하면
//  세트가 구성 0개 = 일반 품목이 되어 이후 세트 출고가 세트 id 로 기록되고 구성품은 안 빠졌다.
//  같은 구성품이 두 줄이면 합치지 않고 거절한다(수량을 더할지 덮을지 사람이 정한다).
export type ReplaceBundleResult = { ok: true; count: number } | { ok: false; error: string; status: number };
export async function replaceBundleComponents(
  sb: ReturnType<typeof supabaseAdmin>,
  parentId: string,
  comps: BundleComponent[],
  label?: (componentId: string) => string,
): Promise<ReplaceBundleResult> {
  const rows = comps.map((c) => ({ component_id: c.component_id, qty: Math.max(1, Math.round(Number(c.qty) || 1)) }));
  const name = (id: string) => (label ? label(id) : id);
  if (rows.some((r) => !r.component_id)) return { ok: false, error: "구성품이 비었습니다.", status: 400 };
  if (rows.some((r) => r.component_id === parentId)) return { ok: false, error: "자기 자신을 구성품으로 넣을 수 없습니다.", status: 400 };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.component_id)) return { ok: false, error: `구성품 ${name(r.component_id)} 가 두 줄 있습니다 — 한 줄로 합치세요.`, status: 400 };
    seen.add(r.component_id);
  }
  const cycleMsg = "묶음 순환이 생깁니다 — 구성품이 이 세트를(직·간접) 포함하고 있습니다.";

  const rpc = await sb.rpc("replace_bundle", { p_parent: parentId, p_rows: rows });
  if (!rpc.error) return { ok: true, count: Number(rpc.data) || rows.length };
  const m = rpc.error.message || "";
  const rpcMissing = rpc.error.code === "PGRST202" || /could not find the function|replace_bundle.*does not exist/i.test(m);
  if (!rpcMissing) {
    if (/BUNDLE_CYCLE/.test(m)) return { ok: false, error: cycleMsg, status: 400 };
    if (/BUNDLE_DUPLICATE/.test(m)) return { ok: false, error: "같은 구성품이 두 줄 있습니다 — 한 줄로 합치세요.", status: 400 };
    if (/BUNDLE_SELF/.test(m)) return { ok: false, error: "자기 자신을 구성품으로 넣을 수 없습니다.", status: 400 };
    if (rpc.error.code === "23503") return { ok: false, error: "구성품 상품을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요.", status: 400 };
    return { ok: false, error: `세트 구성 저장 실패(${m}) — 기존 구성은 그대로입니다.`, status: 500 };
  }

  // ── 131 미적용 폴백: 순환 검사(전체 구성 조회 실패는 던진다) → upsert(한 문장) → 빠진 구성 삭제.
  //  upsert 가 실패하면 기존 구성이 그대로이고, 삭제가 실패하면 옛 구성품이 남는다(0개가 되지는 않는다).
  if (rows.length && wouldCreateCycle(await getAllBundles(sb), parentId, rows.map((r) => r.component_id)))
    return { ok: false, error: cycleMsg, status: 400 };
  if (rows.length) {
    const up = await sb.from("product_bundles")
      .upsert(rows.map((r) => ({ parent_id: parentId, ...r })), { onConflict: "parent_id,component_id" });
    if (up.error) return { ok: false, error: `세트 구성 저장 실패(${up.error.message}) — 기존 구성은 그대로입니다.`, status: 500 };
  }
  let del = sb.from("product_bundles").delete().eq("parent_id", parentId);
  if (rows.length) del = del.not("component_id", "in", `(${rows.map((r) => r.component_id).join(",")})`);
  const dr = await del;
  if (dr.error) return { ok: false, error: `빠진 구성품을 지우지 못했습니다(${dr.error.message}) — 묶음 화면에서 구성을 확인하세요.`, status: 500 };
  return { ok: true, count: rows.length };
}

// 한 세트를 만들 수 있는 수량 = min( 구성품 현재고 ÷ 구성수량 ). 구성품 없으면 0.
export function bundleAvailable(components: BundleComponent[], stockOf: (id: string) => number): number {
  if (!components.length) return 0;
  return Math.min(...components.map((c) => Math.floor((stockOf(c.component_id) || 0) / c.qty)));
}
