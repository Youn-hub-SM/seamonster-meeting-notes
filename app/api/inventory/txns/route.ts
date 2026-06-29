import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/inventory/txns?product_id=&type=&from=&to=&limit= — 원장(활동 히스토리·구매판매·조정 공용).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let q = supabaseAdmin()
      .from("inventory_txns")
      .select("id, product_id, type, qty, unit_amount, txn_date, partner, memo, created_by, created_at, products(name, sku)")
      .order("txn_date", { ascending: false })
      .order("created_at", { ascending: false });

    const product_id = sp.get("product_id");
    const type = sp.get("type");
    const from = sp.get("from");
    const to = sp.get("to");
    const limit = Math.min(2000, Math.max(1, Number(sp.get("limit")) || 500));
    if (product_id) q = q.eq("product_id", product_id);
    if (type) q = q.eq("type", type);
    if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
    if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);
    q = q.limit(limit);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []).map((r) => {
      const p = (r as { products?: { name?: string; sku?: string | null } }).products;
      return { ...r, product_name: p?.name || "(삭제된 품목)", sku: p?.sku ?? null, products: undefined };
    });
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[inventory/txns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "원장 조회 실패") }, { status: 500 });
  }
}
