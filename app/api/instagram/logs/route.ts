import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 최근 발송 로그 100건(규칙 제목 표시용으로 규칙 캡션 조인)
export async function GET() {
  try {
    const db = supabaseAdmin();
    const { data, error } = await db.from("ig_dm_logs")
      .select("id, rule_id, ig_user_id, commenter_username, comment_text, status, error, created_at")
      .order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const ruleIds = [...new Set((data || []).map((l) => l.rule_id).filter(Boolean))] as string[];
    const captions: Record<string, string> = {};
    if (ruleIds.length > 0) {
      const { data: rules } = await db.from("ig_dm_rules").select("id, media_caption, media_permalink").in("id", ruleIds);
      for (const r of rules || []) captions[r.id] = r.media_caption || r.media_permalink || "";
    }
    return NextResponse.json({ ok: true, logs: (data || []).map((l) => ({ ...l, rule_caption: l.rule_id ? captions[l.rule_id] || "" : "" })) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
