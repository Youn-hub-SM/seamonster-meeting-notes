import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/inventory/bundles — 등록된 묶음 전체(부모별 구성품).
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const br = await sb.from("product_bundles").select("parent_id, component_id, qty");
    if (br.error) return NextResponse.json({ ok: true, bundles: [], note: "묶음 테이블 미적용(037)" });
    const ids = new Set<string>();
    for (const b of br.data ?? []) { ids.add(b.parent_id); ids.add(b.component_id); }
    const pr = ids.size ? await sb.from("products").select("id, sku, name, spec").in("id", [...ids]) : { data: [] as { id: string; sku: string | null; name: string; spec: string | null }[] };
    const pMap = new Map((pr.data ?? []).map((p) => [p.id, p]));
    const grouped = new Map<string, { parent_id: string; parent_sku: string | null; parent_name: string; components: { component_id: string; sku: string | null; name: string; spec: string | null; qty: number }[] }>();
    for (const b of br.data ?? []) {
      const pp = pMap.get(b.parent_id);
      let g = grouped.get(b.parent_id);
      if (!g) { g = { parent_id: b.parent_id, parent_sku: pp?.sku ?? null, parent_name: pp?.name ?? "(삭제된 상품)", components: [] }; grouped.set(b.parent_id, g); }
      const cp = pMap.get(b.component_id);
      g.components.push({ component_id: b.component_id, sku: cp?.sku ?? null, name: cp?.name ?? "(삭제됨)", spec: cp?.spec ?? null, qty: b.qty });
    }
    const bundles = [...grouped.values()].sort((a, b) => a.parent_name.localeCompare(b.parent_name, "ko"));
    return NextResponse.json({ ok: true, bundles });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "묶음 조회 실패") }, { status: 500 });
  }
}

// DELETE /api/inventory/bundles?parent=<id> — 그 묶음의 구성 전체 삭제(부모 상품 자체는 유지).
export async function DELETE(req: NextRequest) {
  try {
    const parent = req.nextUrl.searchParams.get("parent");
    if (!parent) return NextResponse.json({ ok: false, error: "parent 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("product_bundles").delete().eq("parent_id", parent);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
