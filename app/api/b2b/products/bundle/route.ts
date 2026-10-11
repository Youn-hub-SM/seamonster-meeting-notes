import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { bundlesTableMissing, replaceBundleComponents } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";

// GET /api/b2b/products/bundle?parent=<id> — 그 상품의 묶음 구성품(+상품정보).
//  테이블 없음(037)만 빈 구성 — 일시 오류를 '구성 없음'으로 보여 주면 편집 창이 빈 채로 열리고, 그대로 저장하면 세트가 풀린다(S4).
export async function GET(req: NextRequest) {
  try {
    const parent = req.nextUrl.searchParams.get("parent");
    if (!parent) return NextResponse.json({ ok: false, error: "parent 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const br = await sb.from("product_bundles").select("component_id, qty").eq("parent_id", parent);
    if (br.error) {
      if (bundlesTableMissing(br.error)) return NextResponse.json({ ok: true, components: [], note: "묶음 테이블 미적용(037)" });
      throw br.error;
    }
    const ids = (br.data ?? []).map((b) => b.component_id);
    const prods = ids.length ? await sb.from("products").select("id, sku, name, spec, unit").in("id", ids) : { data: [], error: null };
    if (prods.error) throw prods.error;
    const pMap = new Map((prods.data ?? []).map((p) => [p.id, p]));
    const components = (br.data ?? []).map((b) => {
      const p = pMap.get(b.component_id);
      return { component_id: b.component_id, qty: b.qty, sku: p?.sku ?? null, name: p?.name ?? "(삭제된 품목)", spec: p?.spec ?? null, unit: p?.unit ?? "" };
    });
    return NextResponse.json({ ok: true, components });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "묶음 조회 실패") }, { status: 500 });
  }
}

// PUT { parent_id, components: [{component_id, qty}] } — 그 상품의 구성품을 전체 교체.
//  교체는 replaceBundleComponents 한 곳(131 RPC — 검증·순환 검사·삭제·넣기가 한 트랜잭션, 실패하면 기존 구성 그대로).
//  같은 구성품 두 줄은 합치지 않고 거절한다(종전엔 뒤 값으로 조용히 덮었다 — 수량이 사라진다).
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { parent_id?: string; components?: { component_id?: string; qty?: number }[] };
    const parent = String(body.parent_id || "");
    if (!parent) return NextResponse.json({ ok: false, error: "parent_id 가 필요합니다." }, { status: 400 });
    const rows = (Array.isArray(body.components) ? body.components : [])
      .map((c) => ({ component_id: String(c.component_id || ""), qty: Math.max(1, Math.round(Number(c.qty) || 1)) }))
      .filter((c) => c.component_id);

    const sb = supabaseAdmin();
    let names = new Map<string, string>();
    if (rows.length) {
      const { data } = await sb.from("products").select("id, name").in("id", rows.map((r) => r.component_id));
      names = new Map((data ?? []).map((p) => [String(p.id), String(p.name || "")]));
    }
    const r = await replaceBundleComponents(sb, parent, rows, (id) => `'${names.get(id) || "품목"}'`);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    if (rows.length) {
      // 세트가 되면 '재고 관리 사용 안함'(121)은 풀어 둔다 — 세트는 자체 재고가 없고 화면에서 이 표시를 보거나 되돌릴 수 없다.
      //  121 미적용 DB 면 컬럼 오류를 무시한다.
      const un = await sb.from("products").update({ stock_tracked: true }).eq("id", parent).eq("stock_tracked", false);
      if (un.error && !/stock_tracked/i.test(un.error.message || "")) console.warn("[b2b/products/bundle] 재고 관리 표시 해제 실패:", un.error.message);
    }
    return NextResponse.json({ ok: true, count: r.count });
  } catch (err) {
    console.error("[b2b/products/bundle PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "묶음 저장 실패") }, { status: 500 });
  }
}
