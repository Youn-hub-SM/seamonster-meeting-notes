import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const productId = new URL(req.url).searchParams.get("product_id");
    if (!productId) {
      return NextResponse.json(
        { ok: false, error: "product_id 가 필요합니다." },
        { status: 400 }
      );
    }
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("cost_history")
      .select("*")
      .eq("product_id", productId)
      .order("changed_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return NextResponse.json({ ok: true, history: data ?? [] });
  } catch (err) {
    console.error("[b2b/products/cost-history GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
