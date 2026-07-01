import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logProductChange } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type InBundle = { parentSku?: string; name?: string; components?: { sku?: string; qty?: number }[] };

// POST /api/inventory/bundles/import/apply { bundles: [{parentSku, name, components:[{sku, qty}]}] }
//  묶음 부모SKU 가 상품에 없으면 최소 정보로 생성(원가·가격 0). 구성품은 기존 상품이어야 함. 구성 교체(전체 대체).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { bundles?: InBundle[] };
    const bundles = Array.isArray(body.bundles) ? body.bundles : [];
    if (!bundles.length) return NextResponse.json({ ok: false, error: "반영할 묶음이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: products, error } = await sb.from("products").select("id, sku, name").eq("active", true);
    if (error) throw error;
    const bySku = new Map<string, string[]>();
    for (const p of products ?? []) { const k = p.sku ? String(p.sku).trim() : ""; if (k) bySku.set(k, [...(bySku.get(k) || []), p.id]); }

    let applied = 0, created = 0;
    const errors: string[] = [];

    for (const b of bundles) {
      const parentSku = String(b.parentSku || "").trim();
      const comps = (Array.isArray(b.components) ? b.components : []).map((c) => ({ sku: String(c.sku || "").trim(), qty: Math.max(1, Math.round(Number(c.qty) || 1)) })).filter((c) => c.sku);
      if (!parentSku || !comps.length) { errors.push(`${parentSku || "?"}: 정보 부족`); continue; }

      // 부모 확인/생성
      let parentId: string;
      const pIds = bySku.get(parentSku);
      if (pIds && pIds.length === 1) parentId = pIds[0];
      else if (pIds && pIds.length > 1) { errors.push(`묶음SKU '${parentSku}' 중복 — 건너뜀`); continue; }
      else {
        const name = String(b.name || "").trim() || parentSku;
        const ins = await sb.from("products").insert({ sku: parentSku, name, unit: "개", cost_price: 0, sale_price: 0, tax_type: "taxable", active: true }).select("id").single();
        if (ins.error) { errors.push(`묶음SKU '${parentSku}' 생성 실패: ${ins.error.message}`); continue; }
        parentId = ins.data.id;
        bySku.set(parentSku, [parentId]);
        created++;
        await logProductChange("created", name, parentSku);
      }

      // 구성품 확인
      const rows: { parent_id: string; component_id: string; qty: number }[] = [];
      let compErr = "";
      for (const c of comps) {
        if (c.sku === parentSku) { compErr = "자기 자신을 구성품으로 넣을 수 없음"; break; }
        const ids = bySku.get(c.sku);
        if (!ids || ids.length === 0) { compErr = `구성품 '${c.sku}' 없음`; break; }
        if (ids.length > 1) { compErr = `구성품 '${c.sku}' 중복`; break; }
        rows.push({ parent_id: parentId, component_id: ids[0], qty: c.qty });
      }
      if (compErr) { errors.push(`${parentSku}: ${compErr}`); continue; }

      // 구성 교체
      const del = await sb.from("product_bundles").delete().eq("parent_id", parentId);
      if (del.error) { errors.push(`${parentSku}: ${del.error.message}`); continue; }
      const insb = await sb.from("product_bundles").insert(rows);
      if (insb.error) { errors.push(`${parentSku}: ${insb.error.message}`); continue; }
      applied++;
    }

    return NextResponse.json({ ok: errors.length === 0, applied, created, errors });
  } catch (err) {
    console.error("[bundles/import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "묶음 반영 실패") }, { status: 500 });
  }
}
