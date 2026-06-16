import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/activity
//   ?limit=30&offset=0&type=order.status_changed&actor=지인&q=디아노체&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//   - 파라미터 없으면 최근 30건 (대시보드 우측 피드와 호환)
//   - 히스토리 탭: 필터 + offset 페이지네이션 + hasMore
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const limitParam = Number(sp.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 30;
    const offsetParam = Number(sp.get("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

    const type = (sp.get("type") || "").trim();
    const actor = (sp.get("actor") || "").trim();
    const q = (sp.get("q") || "").trim();
    const dateFrom = (sp.get("date_from") || "").trim();
    const dateTo = (sp.get("date_to") || "").trim();

    const sb = supabaseAdmin();
    let query = sb
      .from("activity_log")
      .select("*") // actor 컬럼(migration 009) 포함
      .order("created_at", { ascending: false });

    if (type) query = query.eq("event_type", type);
    if (actor) query = query.eq("actor", actor);
    if (q) query = query.ilike("summary", `%${q}%`);
    if (dateFrom) query = query.gte("created_at", dateFrom);
    if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59.999`);

    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;

    const activities = data ?? [];
    return NextResponse.json({ ok: true, activities, hasMore: activities.length === limit });
  } catch (err) {
    console.error("[b2b/activity GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
