import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/sales/activity?limit=&offset=&type=&actor=&q=&date_from=&date_to=
//   activity_log 중 매출(sales.*) 이벤트만 조회 — 업로드·되돌리기·리포트발송·설정변경·주문검색(전화조회) 감사.
//   type 없으면 sales.* 전체(향후 추가되는 sales 이벤트도 자동 포함). type 지정 시 sales.* 만 허용.
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const limitParam = Number(sp.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
    const offsetParam = Number(sp.get("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

    const type = (sp.get("type") || "").trim();
    const actor = (sp.get("actor") || "").trim();
    const q = (sp.get("q") || "").trim();
    const dateFrom = (sp.get("date_from") || "").trim();
    const dateTo = (sp.get("date_to") || "").trim();

    const sb = supabaseAdmin();
    let query = sb.from("activity_log").select("*").order("created_at", { ascending: false });

    if (type) {
      // sales.* 로 시작하는 값만 허용(다른 스코프 이벤트 유출 방지)
      const types = type.split(",").map((s) => s.trim()).filter((s) => s.startsWith("sales."));
      query = types.length ? query.in("event_type", types) : query.eq("event_type", "sales.__none__");
    } else {
      query = query.like("event_type", "sales.%");
    }
    if (actor) query = query.eq("actor", actor);
    if (q) query = query.ilike("summary", `%${q.slice(0, 100).replace(/[%_]/g, " ")}%`); // LIKE 와일드카드 무력화
    if (dateFrom) query = query.gte("created_at", dateFrom);
    if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59.999`);

    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;
    const activities = data ?? [];
    return NextResponse.json({ ok: true, activities, hasMore: activities.length === limit });
  } catch (err) {
    console.error("[sales/activity GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
