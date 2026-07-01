import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/inventory/txns?product_id=&type=&from=&to=&limit= — 원장(활동 히스토리·구매판매·조정 공용).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const product_id = sp.get("product_id");
    const type = sp.get("type");
    const channel = sp.get("channel");
    const from = sp.get("from");
    const to = sp.get("to");
    const limit = Math.min(2000, Math.max(1, Number(sp.get("limit")) || 500));
    // channel 컬럼(036) 미적용 환경에선 select/필터에서 빼고 폴백.
    const run = async (withChannel: boolean) => {
      let q = supabaseAdmin()
        .from("inventory_txns")
        .select(`id, product_id, type, ${withChannel ? "channel, " : ""}qty, unit_amount, txn_date, partner, memo, created_by, created_at, products(name, sku)`)
        .order("txn_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (product_id) q = q.eq("product_id", product_id);
      if (type) q = q.eq("type", type);
      if (withChannel && (channel === "도매" || channel === "소매")) q = q.eq("channel", channel);
      if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
      if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);
      return q.limit(limit);
    };
    let res = await run(true);
    if (res.error && /channel/i.test(res.error.message)) res = await run(false);
    if (res.error) throw res.error;
    const rows = ((res.data ?? []) as unknown as Record<string, unknown>[]).map((r) => {
      const p = r.products as { name?: string; sku?: string | null } | undefined;
      return { ...r, product_name: p?.name || "(삭제된 품목)", sku: p?.sku ?? null, products: undefined };
    });
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[inventory/txns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "원장 조회 실패") }, { status: 500 });
  }
}
