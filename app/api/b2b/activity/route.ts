import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/activity?limit=30
// 최근 변경 이력 (대시보드 우측 피드용)
export async function GET(req: NextRequest) {
  try {
    const limitParam = Number(new URL(req.url).searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 30;

    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("activity_log")
      .select("id, event_type, summary, order_id, order_no, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    return NextResponse.json({ ok: true, activities: data ?? [] });
  } catch (err) {
    console.error("[b2b/activity GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
