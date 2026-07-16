import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logProductChange } from "@/app/lib/b2b-activity";
import { diffProduct } from "@/app/lib/product-diff";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/production/products/apply  { rows: [{sku, name, spec}] }
// 미리보기에서 확정한 행을 products 에 반영. SKU 기준 — 있으면 제품명·옵션만 갱신, 없으면 신규 추가.
//  금액(원가·판매가)·이익률 상세는 건드리지 않음.

interface Row { sku: string; name: string; spec: string | null }

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: Row[] };
    const rows = (body.rows || []).filter((r) => r && r.sku && r.name);
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "반영할 항목이 없습니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();
    const { data: products, error } = await sb.from("products").select("id, sku, name, spec");
    if (error) throw error;
    const bySku = new Map<string, { id: string; name: string; spec: string | null }>();
    for (const p of products ?? []) {
      if (p.sku) bySku.set(String(p.sku).toUpperCase(), { id: p.id, name: p.name, spec: p.spec });
    }

    let added = 0;
    let updated = 0;

    for (const r of rows) {
      const sku = r.sku.trim();
      const name = r.name.trim();
      const spec = r.spec ? String(r.spec).trim() || null : null;
      let ex = bySku.get(sku.toUpperCase());

      if (!ex) {
        // 신규 — 행 단위 insert. 금액/이익률은 0/기본값, 활성. (사용자가 추후 원가표에서 보완)
        //  073 유니크 인덱스에 걸리면(경합·대소문자 변형) 기존 행 갱신으로 전환 — 배치 전체가 죽지 않게.
        const { data: ins, error: iErr } = await sb
          .from("products")
          .insert({
            sku,
            name,
            spec,
            unit: "개",
            cost_price: 0,
            sale_price: 0,
            tax_type: "taxable",
            active: true,
            cost_material: 0,
            pkg_inner: 0,
            pkg_label: 0,
            pkg_outer: 0,
          })
          .select("id")
          .single();
        if (!iErr) {
          added++;
          bySku.set(sku.toUpperCase(), { id: ins.id, name, spec }); // 같은 파일 내 중복 SKU 행은 갱신으로
          await logProductChange("created", name, sku, { source: "품목업로드(생산)" });
          continue;
        }
        if (iErr.code !== "23505") throw iErr;
        // 경합 등으로 방금 같은 SKU 가 먼저 들어간 경우 — 그 행을 정확히(exact) 재조회해 갱신으로 전환.
        //  ilike 는 %·_·* 가 와일드카드라 엉뚱한 행을 집을 수 있어 eq(정확 일치)만 사용.
        const { data: found } = await sb.from("products").select("id, name, spec").eq("sku", sku).limit(1).maybeSingle();
        if (!found) throw iErr; // 대소문자만 다른 희귀 경합은 원본 에러 노출(073 가드가 이런 데이터를 애초에 막음)
        ex = { id: found.id, name: found.name, spec: found.spec };
        bySku.set(sku.toUpperCase(), ex);
      }

      const nameChanged = (ex.name || "") !== name;
      const specChanged = (ex.spec || "") !== (spec || "");
      if (nameChanged || specChanged) {
        const { error: uErr } = await sb.from("products").update({ name, spec }).eq("id", ex.id);
        if (uErr) throw uErr;
        updated++;
        const changes = diffProduct({ name: ex.name, spec: ex.spec }, { name, spec });
        await logProductChange("updated", name, sku, { source: "품목업로드(생산)", changes, productId: ex.id });
        bySku.set(sku.toUpperCase(), { id: ex.id, name, spec });
      }
    }

    return NextResponse.json({ ok: true, added, updated });
  } catch (err) {
    console.error("[production/products/apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "반영 실패") }, { status: 500 });
  }
}
