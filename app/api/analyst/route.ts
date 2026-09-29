import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { runDailyAnalyst, sendAnalystToTeams, kstDay, RUN_STALE_MS } from "@/app/lib/analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 사실 집계 + AI 도구 루프(최대 약 4분)

// 대표 전용 — 일일 리포트와 같은 관리자 판정
async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return isAdminName(name || "");
}

// GET ?date=YYYY-MM-DD(분석 대상일, 기본 어제) — 분석 단건 + 최근 날짜 목록
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 화면입니다." }, { status: 403 });
    const q = req.nextUrl.searchParams.get("date");
    const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : kstDay(1);
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("analyst_reports")
      .select("report_date, status, sales_ready, report_md, model, usage, trigger, error, sent_at, created_at, updated_at").eq("report_date", date).maybeSingle();
    if (error) {
      if (/analyst_reports/i.test(error.message)) return NextResponse.json({ ok: true, report: null, recent: [], date, pending_migration: true });
      throw error;
    }
    const { data: recent } = await sb.from("analyst_reports").select("report_date").order("report_date", { ascending: false }).limit(30);
    // running = 지금 도는 중(6분 넘은 'running' 은 죽은 실행 — 다시 분석 가능)
    const report = data ? { ...data, running: data.status === "running" && Date.now() - Date.parse(String(data.updated_at)) < RUN_STALE_MS } : null;
    return NextResponse.json({ ok: true, report, recent: (recent ?? []).map((r) => r.report_date as string), date });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "어제 분석 조회 실패") }, { status: 500 });
  }
}

// POST { date?, force?, send? } — 분석(force=다시 분석), send=true 면 분석 뒤(또는 기존 본문을) 팀즈 발송
export async function POST(req: NextRequest) {
  const startedAt = Date.now(); // 분석 마감(270초)은 요청 시작 기준
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 기능입니다." }, { status: 403 });
    const b = (await req.json().catch(() => ({}))) as { date?: string; force?: boolean; send?: boolean };
    const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : kstDay(1);
    // 보내기만: 이미 분석이 있으면 다시 돌리지 않는다(불필요한 AI 호출 방지)
    if (b.send && !b.force) {
      const { data } = await supabaseAdmin().from("analyst_reports").select("report_md").eq("report_date", date).maybeSingle();
      if (data?.report_md) {
        const sent = await sendAnalystToTeams(date);
        return NextResponse.json({ ok: sent.ok, date, sent, ...(sent.ok ? {} : { error: sent.error }) }, { status: sent.ok ? 200 : 502 });
      }
    }
    const r = await runDailyAnalyst({ date, trigger: "manual", force: b.force !== false, send: !!b.send, startedAt });
    if (!r.ok) return NextResponse.json(r, { status: r.pending_migration ? 503 : r.skipped ? 409 : 502 });
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "어제 분석 실패") }, { status: 500 });
  }
}
