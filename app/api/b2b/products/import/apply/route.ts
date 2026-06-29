import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeProduct, type ProductInput } from "@/app/lib/b2b-types";
import { logProductChange } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 정규화된 ProductInput → DB 컬럼(매스 어사인 방지: 화이트리스트)
function dbRow(clean: ProductInput) {
  return {
    sku: clean.sku,
    name: clean.name,
    spec: clean.spec,
    unit: clean.unit,
    cost_price: clean.cost_price,
    retail_price: clean.retail_price,
    sale_price: clean.sale_price,
    tax_type: clean.tax_type,
    active: clean.active,
    notes: clean.notes,
    cost_material: clean.cost_material,
    pkg_inner: clean.pkg_inner,
    pkg_label: clean.pkg_label,
    pkg_outer: clean.pkg_outer,
    volume_kg: clean.volume_kg,
  };
}

// POST /api/b2b/products/import/apply  { creates: ProductInput[], updates: ProductInput[] }
//  미리보기(import)에서 컨펌한 행만 받아 실제 반영. 서버에서 재정규화(클라이언트 변조 방어).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { creates?: ProductInput[]; updates?: ProductInput[] };
    const creates = Array.isArray(body.creates) ? body.creates : [];
    const updates = Array.isArray(body.updates) ? body.updates : [];
    const sb = supabaseAdmin();
    let created = 0, updated = 0;
    const errors: string[] = [];

    for (const input of creates) {
      const clean = normalizeProduct(input);
      if (!clean.name) { errors.push("품목명 누락 행 건너뜀"); continue; }
      const { error } = await sb.from("products").insert(dbRow(clean));
      if (error) { errors.push(`${clean.name}: ${error.message}`); continue; }
      created++;
      await logProductChange("created", clean.name, clean.sku);
    }

    for (const input of updates) {
      if (!input.id) { errors.push(`${input.name || "?"}: id 없음`); continue; }
      const clean = normalizeProduct(input);
      const { error } = await sb.from("products").update(dbRow(clean)).eq("id", input.id);
      if (error) { errors.push(`${clean.name}: ${error.message}`); continue; }
      updated++;
      await logProductChange("updated", clean.name, clean.sku);
    }

    return NextResponse.json({ ok: errors.length === 0, created, updated, errors });
  } catch (err) {
    console.error("[b2b/products import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "적용 실패") }, { status: 500 });
  }
}
