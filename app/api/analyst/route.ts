import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { runDailyAnalyst, kstDay, RUN_STALE_MS } from "@/app/lib/analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 사실 집계 + AI 도구 루프(최대 약 4분)

// 일일 종합 리포트(2026-09-30) — 로그인한 모두가 보고, 만들고, 팀즈로 보낸다(담당자가 매출 업로드 후 생성·발송).
//  매출이 그대로인데 새로 분석(force)은 관리자만 — 반복 AI 비용 통제. 매출이 바뀌었으면 누구나 다시 분석된다(지문 비교).
async function who(req: NextRequest): Promise<{ name: string | null; admin: boolean }> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return { name, admin: isAdminName(name || "") };
}

// GET ?date=YYYY-MM-DD(분석 대상일, 기본 어제) — 리포트 단건 + 최근 날짜 목록 + 관리자 여부
export async function GET(req: NextRequest) {
  try {
    const u = await who(req);
    if (!u.name) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const q = req.nextUrl.searchParams.get("date");
    const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : kstDay(1);
    const sb = supabaseAdmin();
    const cols = "report_date, status, sales_ready, sales_fp, report_md, model, usage, trigger, error, sent_at, created_at, updated_at";
    let q1 = await sb.from("analyst_reports").select(`${cols}, sent_fp`).eq("report_date", date).maybeSingle();
    if (q1.error && /sent_fp/i.test(q1.error.message)) q1 = await sb.from("analyst_reports").select(cols).eq("report_date", date).maybeSingle(); // 123 미적용
    const { data, error } = q1 as { data: Record<string, unknown> | null; error: { message: string } | null };
    if (error) {
      if (/analyst_reports/i.test(error.message)) return NextResponse.json({ ok: true, report: null, recent: [], date, admin: u.admin, pending_migration: true });
      throw error;
    }
    const { data: recent } = await sb.from("analyst_reports").select("report_date").order("report_date", { ascending: false }).limit(30);
    // running = 지금 도는 중(6분 넘은 'running' 은 죽은 실행 — 다시 분석 가능)
    // sent_current = 지금 버전을 팀즈로 보냈다 = 마지막 생성(updated_at) 뒤에 보냈다 — 다시 분석했으면 false
    const report = data ? {
      ...data,
      running: data.status === "running" && Date.now() - Date.parse(String(data.updated_at)) < RUN_STALE_MS,
      sent_current: !!data.sent_at && Date.parse(String(data.sent_at)) >= Date.parse(String(data.updated_at)),
    } : null;
    return NextResponse.json({ ok: true, report, recent: (recent ?? []).map((r) => r.report_date as string), date, admin: u.admin });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "일일 종합 리포트 조회 실패") }, { status: 500 });
  }
}

// POST { date?, force?, send? } — 분석(force = 매출이 그대로여도 새로, 관리자만), send=true 면 기존 본문을 발송(없으면 분석 뒤 발송)
export async function POST(req: NextRequest) {
  const startedAt = Date.now(); // 분석 마감(270초)은 요청 시작 기준
  try {
    const u = await who(req);
    if (!u.name) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as { date?: string; force?: boolean; send?: boolean };
    const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : kstDay(1);
    const force = u.admin && b.force === true && !b.send;
    // 보내기: 지금 매출로 만든 리포트가 있으면 그 본문을, 매출이 바뀌었으면 다시 분석한 뒤 보낸다. 분석 중이면 거절(runDailyAnalyst).
    const r = await runDailyAnalyst({ date, trigger: "manual", force, send: !!b.send, startedAt });
    if (!r.ok) return NextResponse.json(r, { status: r.pending_migration ? 503 : r.skipped ? 409 : 502 });
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "일일 종합 리포트 생성 실패") }, { status: 500 });
  }
}
