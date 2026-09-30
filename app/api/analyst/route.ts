import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { runReport, rowKey, RUN_STALE_MS } from "@/app/lib/analyst";
import { specFor, isFinished } from "@/app/lib/analyst-period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 사실 집계 + AI 도구 루프(최대 약 4분)

// 종합 리포트(일일·주간·월간, 2026-09-30) — 로그인한 모두가 보고, 만들고, 팀즈로 보낸다(담당자가 매출 업로드 후 생성·발송).
//  매출이 그대로인데 새로 분석(force)은 관리자만 — 반복 AI 비용 통제. 매출이 바뀌었으면 누구나 다시 분석된다(지문 비교).
//  period = daily(기본)|weekly|monthly, date = 그 기간 안의 아무 날(주간·월간은 그 주·달로 맞춘다). 주간·월간은 끝난 기간만.
async function who(req: NextRequest): Promise<{ name: string | null; admin: boolean }> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return { name, admin: isAdminName(name || "") };
}
const dateOf = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

// GET ?period=&date= — 리포트 단건 + 관리자 여부 + 기간
export async function GET(req: NextRequest) {
  try {
    const u = await who(req);
    if (!u.name) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const sp = req.nextUrl.searchParams;
    const spec = specFor(sp.get("period"), dateOf(sp.get("date")));
    const meta = { period: spec.period, date: spec.key, range: spec.range, label: spec.label, title: spec.title, admin: u.admin };
    const sb = supabaseAdmin();
    const cols = "report_date, status, sales_ready, sales_fp, report_md, model, usage, trigger, error, sent_at, created_at, updated_at";
    const q = (c: string) => { let x = sb.from(spec.table).select(c); for (const [k, v] of Object.entries(rowKey(spec))) x = x.eq(k, v); return x.maybeSingle(); };
    let q1 = await q(`${cols}, sent_fp`);
    if (q1.error && /sent_fp/i.test(q1.error.message)) q1 = await q(cols); // 123 미적용
    const { data, error } = q1 as unknown as { data: Record<string, unknown> | null; error: { message: string } | null };
    if (error) {
      if (new RegExp(spec.table, "i").test(error.message)) return NextResponse.json({ ok: true, report: null, ...meta, pending_migration: spec.migration });
      throw error;
    }
    // running = 지금 도는 중(6분 넘은 'running' 은 죽은 실행 — 다시 분석 가능)
    // sent_current = 지금 버전을 팀즈로 보냈다 = 마지막 생성(updated_at) 뒤에 보냈다 — 다시 분석했으면 false
    const report = data ? {
      ...data,
      running: data.status === "running" && Date.now() - Date.parse(String(data.updated_at)) < RUN_STALE_MS,
      sent_current: !!data.sent_at && Date.parse(String(data.sent_at)) >= Date.parse(String(data.updated_at)),
    } : null;
    return NextResponse.json({ ok: true, report, ...meta });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "종합 리포트 조회 실패") }, { status: 500 });
  }
}

// POST { period?, date?, force?, send? } — 분석(force = 매출이 그대로여도 새로, 관리자만), send=true 면 기존 본문을 발송(매출이 바뀌었으면 다시 분석 뒤 발송)
export async function POST(req: NextRequest) {
  const startedAt = Date.now(); // 분석 마감(270초)은 요청 시작 기준
  try {
    const u = await who(req);
    if (!u.name) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as { period?: string; date?: string; force?: boolean; send?: boolean };
    const spec = specFor(b.period, dateOf(b.date));
    if (spec.period !== "daily" && !isFinished(spec.range))
      return NextResponse.json({ ok: false, error: `아직 끝나지 않은 기간입니다(${spec.label}).` }, { status: 400 });
    const force = u.admin && b.force === true && !b.send;
    const r = await runReport(spec, { trigger: "manual", force, send: !!b.send, startedAt });
    if (!r.ok) return NextResponse.json(r, { status: r.pending_migration ? 503 : r.skipped ? 409 : 502 });
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "종합 리포트 생성 실패") }, { status: 500 });
  }
}
