import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

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
    const toInsert: Record<string, unknown>[] = [];

    for (const r of rows) {
      const sku = r.sku.trim();
      const name = r.name.trim();
      const spec = r.spec ? String(r.spec).trim() || null : null;
      const ex = bySku.get(sku.toUpperCase());
      if (ex) {
        const nameChanged = (ex.name || "") !== name;
        const specChanged = (ex.spec || "") !== (spec || "");
        if (nameChanged || specChanged) {
          const { error: uErr } = await sb.from("products").update({ name, spec }).eq("id", ex.id);
          if (uErr) throw uErr;
          updated++;
        }
      } else {
        // 신규 — 금액/이익률은 0/기본값, 활성. (사용자가 추후 원가표에서 보완)
        toInsert.push({
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
        });
      }
    }

    if (toInsert.length > 0) {
      const { error: iErr } = await sb.from("products").insert(toInsert);
      if (iErr) throw iErr;
      added = toInsert.length;
    }

    return NextResponse.json({ ok: true, added, updated });
  } catch (err) {
    console.error("[production/products/apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "반영 실패") }, { status: 500 });
  }
}
