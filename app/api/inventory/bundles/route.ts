import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { bundlesTableMissing, replaceBundleComponents } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";

// GET /api/inventory/bundles — 등록된 묶음 전체(부모별 구성품).
//  range 페이징 전량(Max Rows 1000 에 잘리면 세트가 구성 일부만 보인다). 테이블 없음(037)만 빈 목록 —
//  그 밖의 조회 오류를 '묶음 없음'으로 보이면 사람이 멀쩡한 세트를 다시 만든다(S4).
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const rows: { parent_id: string; component_id: string; qty: number }[] = [];
    for (let off = 0; off < 100000; off += 1000) {
      const br = await sb.from("product_bundles").select("parent_id, component_id, qty")
        .order("parent_id", { ascending: true }).order("component_id", { ascending: true }).range(off, off + 999);
      if (br.error) {
        if (bundlesTableMissing(br.error)) return NextResponse.json({ ok: true, bundles: [], note: "묶음 테이블 미적용(037)" });
        throw br.error;
      }
      rows.push(...((br.data ?? []) as typeof rows));
      if ((br.data ?? []).length < 1000) break;
    }
    const ids = [...new Set(rows.flatMap((b) => [b.parent_id, b.component_id]))];
    const pMap = new Map<string, { id: string; sku: string | null; name: string; spec: string | null }>();
    for (let i = 0; i < ids.length; i += 200) {
      const pr = await sb.from("products").select("id, sku, name, spec").in("id", ids.slice(i, i + 200));
      if (pr.error) throw pr.error;
      for (const p of pr.data ?? []) pMap.set(p.id, p);
    }
    const grouped = new Map<string, { parent_id: string; parent_sku: string | null; parent_name: string; components: { component_id: string; sku: string | null; name: string; spec: string | null; qty: number }[] }>();
    for (const b of rows) {
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

// DELETE /api/inventory/bundles?parent=<id> — 그 묶음의 구성 전체 삭제(부모 상품 자체는 유지). 교체 함수와 같은 경로(빈 구성으로 교체).
export async function DELETE(req: NextRequest) {
  try {
    const parent = req.nextUrl.searchParams.get("parent");
    if (!parent) return NextResponse.json({ ok: false, error: "parent 가 필요합니다." }, { status: 400 });
    const r = await replaceBundleComponents(supabaseAdmin(), parent, []);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
