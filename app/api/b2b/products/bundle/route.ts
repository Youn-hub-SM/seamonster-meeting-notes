import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getAllBundles, wouldCreateCycle } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";

// GET /api/b2b/products/bundle?parent=<id> — 그 상품의 묶음 구성품(+상품정보).
export async function GET(req: NextRequest) {
  try {
    const parent = req.nextUrl.searchParams.get("parent");
    if (!parent) return NextResponse.json({ ok: false, error: "parent 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const br = await sb.from("product_bundles").select("component_id, qty").eq("parent_id", parent);
    if (br.error) return NextResponse.json({ ok: true, components: [], note: "묶음 테이블 미적용(037)" });
    const ids = (br.data ?? []).map((b) => b.component_id);
    const prods = ids.length ? await sb.from("products").select("id, sku, name, spec, unit").in("id", ids) : { data: [], error: null };
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
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { parent_id?: string; components?: { component_id?: string; qty?: number }[] };
    const parent = String(body.parent_id || "");
    if (!parent) return NextResponse.json({ ok: false, error: "parent_id 가 필요합니다." }, { status: 400 });
    const rows = (Array.isArray(body.components) ? body.components : [])
      .map((c) => ({ parent_id: parent, component_id: String(c.component_id || ""), qty: Math.max(1, Math.round(Number(c.qty) || 1)) }))
      .filter((c) => c.component_id && c.component_id !== parent);
    // 중복 구성품 제거(뒤 값 우선)
    const uniq = new Map(rows.map((r) => [r.component_id, r]));

    const sb = supabaseAdmin();
    // 순환(A⊃B⊃A) 차단 — 순환이 저장되면 재고 전개가 그 가지를 버려 출고가 차감되지 않는다(감사 확정)
    if (uniq.size && wouldCreateCycle(await getAllBundles(sb), parent, [...uniq.keys()])) {
      return NextResponse.json({ ok: false, error: "묶음 순환이 생깁니다 — 구성품이 이 상품을(직·간접) 포함하고 있습니다." }, { status: 400 });
    }
    const del = await sb.from("product_bundles").delete().eq("parent_id", parent);
    if (del.error) throw del.error;
    if (uniq.size) {
      const ins = await sb.from("product_bundles").insert([...uniq.values()]);
      if (ins.error) throw ins.error;
    }
    return NextResponse.json({ ok: true, count: uniq.size });
  } catch (err) {
    console.error("[b2b/products/bundle PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "묶음 저장 실패") }, { status: 500 });
  }
}
