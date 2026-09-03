import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { generateBriefing, sendBriefingToTeams, kstDate } from "@/app/lib/briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 집계 + AI 생성

// 대표 전용 — 관리자만 조회·생성
async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return isAdminName(name || "");
}

// GET ?date=YYYY-MM-DD — 브리핑 단건(기본 오늘) + 최근 날짜 목록
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 화면입니다." }, { status: 403 });
    const q = req.nextUrl.searchParams.get("date");
    const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : kstDate(0);
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("briefings")
      .select("brief_date, insight, data, model, created_at").eq("brief_date", date).maybeSingle();
    if (error) {
      if (/briefings/i.test(error.message)) return NextResponse.json({ ok: true, briefing: null, recent: [], pending_migration: true });
      throw error;
    }
    const { data: recent } = await sb.from("briefings").select("brief_date").order("brief_date", { ascending: false }).limit(30);
    return NextResponse.json({ ok: true, briefing: data ?? null, recent: (recent ?? []).map((r) => r.brief_date as string), date });
  } catch (err) {
    console.error("[briefing GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "브리핑 조회 실패") }, { status: 500 });
  }
}

// POST { date?, force?, send? } — 생성/재생성(force), send=true 면 생성 후(또는 기존 본문을) 팀즈 발송
export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 기능입니다." }, { status: 403 });
    const b = (await req.json().catch(() => ({}))) as { date?: string; force?: boolean; send?: boolean };
    const r = await generateBriefing({ date: b.date, force: b.force !== false }); // 수동 버튼 = 기본 재생성
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || "생성 실패" }, { status: 500 });
    let sent: { ok: boolean; error?: string } | null = null;
    if (b.send) sent = await sendBriefingToTeams(r.date);
    return NextResponse.json({ ok: true, date: r.date, sent });
  } catch (err) {
    console.error("[briefing POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "브리핑 생성 실패") }, { status: 500 });
  }
}
