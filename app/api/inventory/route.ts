import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import type { InventoryRow } from "@/app/lib/inventory";

export const dynamic = "force-dynamic";

// GET /api/inventory[?asof=YYYY-MM-DD] — 품목 + 현재고(Σ txn.qty) + 안전재고.
//  asof 지정 시 그 날짜까지의 누적 수량(과거 수량 조회). 제품목록·부족알림·과거조회 공용.
export async function GET(req: NextRequest) {
  try {
    const asof = req.nextUrl.searchParams.get("asof");
    const sb = supabaseAdmin();
    const asofParam = asof && /^\d{4}-\d{2}-\d{2}$/.test(asof) ? asof : null;
    // 매입단가·원산지·속성은 migration 032 컬럼 — 미적용 환경에선 기본 컬럼으로 폴백(재고 페이지 안 죽게).
    const productsQ = async () => {
      const full = await sb.from("products").select("id, sku, name, spec, unit, cost_price, purchase_price, origin, attrs").eq("active", true).order("name", { ascending: true });
      if (!full.error) return full;
      return sb.from("products").select("id, sku, name, spec, unit, cost_price").eq("active", true).order("name", { ascending: true });
    };
    const [pr, tr, ir] = await Promise.all([
      productsQ(),
      sb.rpc("inventory_stock", { asof: asofParam }), // 품목당 1행 집계(1000행 제한 무관)
      sb.from("inventory_items").select("product_id, min_qty, barcode, location"),
    ]);
    if (pr.error) throw pr.error;
    if (tr.error) throw tr.error;
    if (ir.error) throw ir.error;

    const qtyMap = new Map<string, number>();
    for (const t of (tr.data as { product_id: string; qty: number }[] | null) ?? []) qtyMap.set(t.product_id, Number(t.qty) || 0);
    const itemMap = new Map<string, { min_qty: number; barcode: string | null; location: string | null }>();
    for (const it of ir.data ?? []) itemMap.set(it.product_id, { min_qty: Number(it.min_qty) || 0, barcode: it.barcode, location: it.location });

    const rows: InventoryRow[] = (pr.data ?? []).map((p) => {
      const qty = qtyMap.get(p.id) || 0;
      const meta = itemMap.get(p.id) || { min_qty: 0, barcode: null, location: null };
      const cost = Number(p.cost_price) || 0;
      return {
        product_id: p.id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit,
        cost_price: cost, purchase_price: Number((p as { purchase_price?: number }).purchase_price) || 0,
        origin: (p as { origin?: string | null }).origin ?? null, attrs: (p as { attrs?: string | null }).attrs ?? null,
        qty, min_qty: meta.min_qty, value: qty * cost,
        barcode: meta.barcode, location: meta.location,
        low: meta.min_qty > 0 && qty <= meta.min_qty,
      };
    });
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[inventory GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 조회 실패") }, { status: 500 });
  }
}

// PATCH { product_id, min_qty?, barcode?, location?, memo? } — 품목 재고설정 upsert
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown> & { product_id?: string };
    if (!b.product_id) return NextResponse.json({ ok: false, error: "product_id 가 필요합니다." }, { status: 400 });
    const row: Record<string, unknown> = { product_id: b.product_id, updated_at: new Date().toISOString() };
    if (b.min_qty !== undefined) row.min_qty = Math.max(0, Math.round(Number(b.min_qty) || 0));
    if (b.barcode !== undefined) row.barcode = String(b.barcode || "").trim() || null;
    if (b.location !== undefined) row.location = String(b.location || "").trim() || null;
    if (b.memo !== undefined) row.memo = String(b.memo || "").trim() || null;
    const { error } = await supabaseAdmin().from("inventory_items").upsert(row, { onConflict: "product_id" });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
