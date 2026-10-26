import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { weeklyStats, gaByMedium, weeklyTrend, upsertCrmStats, weekStartOf, kstToday, isCrmSource, CRM_SOURCES, trackedMessages } from "@/app/lib/crm-stats";
import { isSolapiConfigured } from "@/app/lib/solapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?week=YYYY-MM-DD(아무 날짜나 — 그 주 월요일로 맞춤) → 주간 수단별 집계 + GA 매체별 + 12주 추이
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const raw = sp.get("week") || kstToday();
    if (!DATE_RE.test(raw)) return NextResponse.json({ ok: false, error: "week 는 YYYY-MM-DD 여야 합니다." }, { status: 400 });
    const week = weekStartOf(raw);
    const [w, trend] = await Promise.all([weeklyStats(week), weeklyTrend(12, week)]);
    let ga: Awaited<ReturnType<typeof gaByMedium>> = null, gaNote = "";
    try { ga = await gaByMedium(week, w.until); } catch (e) { gaNote = e instanceof Error ? e.message : "GA 조회 실패"; }
    let tracked: Awaited<ReturnType<typeof trackedMessages>>["tracked"] = [], trackedNote = "";
    try { tracked = (await trackedMessages(week, w.until, w.rows)).tracked; } catch (e) { trackedNote = e instanceof Error ? e.message : "추적 메시지 집계 실패"; }
    return NextResponse.json({ ok: true, ...w, ga, gaNote, trend, tracked, trackedNote, sources: w.sources, sourceDefs: CRM_SOURCES, solapi: isSolapiConfigured() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { source, grain, date, template, sent, clicked?, cost?, note? } — 직접 입력(네이버 톡톡·톡스토어·문자 등). 같은 키면 덮어쓴다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    if (!isCrmSource(b.source)) return NextResponse.json({ ok: false, error: "발송 수단이 올바르지 않습니다." }, { status: 400 });
    const date = String(b.date || "");
    if (!DATE_RE.test(date)) return NextResponse.json({ ok: false, error: "날짜는 YYYY-MM-DD 여야 합니다." }, { status: 400 });
    const grain = b.grain === "week" ? "week" : "day";
    const sent = Math.max(0, Math.round(Number(b.sent) || 0));
    const clicked = b.clicked === "" || b.clicked == null ? null : Math.max(0, Math.round(Number(b.clicked) || 0));
    const cost = b.cost === "" || b.cost == null ? null : Math.max(0, Math.round(Number(b.cost) || 0));
    const t = req.cookies.get("b2b_auth")?.value;
    const who = (await verifySession(t)) || resolveUserName(t) || null;
    await upsertCrmStats([{ source: b.source, grain, date: grain === "week" ? weekStartOf(date) : date, template: String(b.template || "").trim().slice(0, 200), sent, delivered: null, clicked, cost, utm_campaign: b.utm_campaign ? String(b.utm_campaign).trim().slice(0, 120) : null, note: String(b.note || "").trim().slice(0, 500), batch: "manual", created_by: who }]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// DELETE ?id=
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id") || "";
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("crm_send_stats").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
