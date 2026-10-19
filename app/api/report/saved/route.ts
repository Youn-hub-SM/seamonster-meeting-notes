import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getSavedReports, addSavedReport, deleteSavedReport, updateSavedReport, type ReportSchedule } from "@/app/lib/report-saved";
import { unresolvedVars, sendScheduledReport } from "@/app/lib/report-schedule";
import { assertSelectOnly } from "@/app/lib/report-ai";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → 저장 리포트 목록
export async function GET() {
  try {
    return NextResponse.json({ ok: true, reports: await getSavedReports() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "목록 조회 실패") }, { status: 500 });
  }
}

// POST { name, question, sql, chart, looker } → 저장
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { name?: string; question?: string; sql?: string; chart?: unknown; looker?: unknown };
    const name = (b.name || "").trim();
    const sql = (b.sql || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "리포트 이름을 입력하세요." }, { status: 400 });
    if (!sql) return NextResponse.json({ ok: false, error: "SQL 이 비어 있습니다." }, { status: 400 });
    // {{변수}} 자리를 임시치환한 뒤 단일 SELECT 인지 검증(구조 안전성)
    const probe = sql.replace(/\{\{\s*[^}]+\s*\}\}/g, "1");
    try { assertSelectOnly(probe); } catch (e) { return NextResponse.json({ ok: false, error: extractErrorMsg(e, "SELECT 쿼리만 저장할 수 있습니다.") }, { status: 400 }); }
    const token = req.cookies.get("b2b_auth")?.value;
    const createdBy = (await verifySession(token)) || resolveUserName(token);
    const rec = await addSavedReport({
      name, question: (b.question || "").trim(), sql,
      chart: (b.chart as never) ?? { type: "none" },
      looker: (b.looker as never) ?? { mode: "na" },
      createdBy,
    });
    return NextResponse.json({ ok: true, report: rec });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}

// DELETE ?id= → 삭제
// PATCH { id, schedule: { freq, to[] } | null }  → 정기 발송 설정·해제(2026-10-19 개선안 3)
//       { id, sendNow: true }                     → 지금 한 번 보내기(설정 확인용, lastSentOn 안 바꿈)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { id?: string; schedule?: ReportSchedule | null; sendNow?: boolean };
    const id = String(b.id || "");
    if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    const token = req.cookies.get("b2b_auth")?.value;
    const user = (await verifySession(token)) || resolveUserName(token) || null;
    const rep = (await getSavedReports()).find((x) => x.id === id);
    if (!rep) return NextResponse.json({ ok: false, error: "저장 리포트를 찾을 수 없습니다." }, { status: 404 });

    if (b.sendNow) {
      if (!rep.schedule) return NextResponse.json({ ok: false, error: "먼저 정기 발송을 설정하세요." }, { status: 400 });
      const r = await sendScheduledReport(rep, { force: true });
      return r.ok ? NextResponse.json({ ok: true, result: r }) : NextResponse.json({ ok: false, error: r.error }, { status: 400 });
    }
    if (b.schedule === null) {
      const rec = await updateSavedReport(id, { schedule: null });
      return NextResponse.json({ ok: true, report: rec });
    }
    const s = b.schedule;
    if (!s || !["daily", "weekly", "monthly"].includes(String(s.freq))) return NextResponse.json({ ok: false, error: "주기를 고르세요(매일·매주·매월)." }, { status: 400 });
    const extra = unresolvedVars(rep.sql);
    if (extra.length) return NextResponse.json({ ok: false, error: `값을 자동으로 채울 수 없는 변수가 있어 예약할 수 없습니다: ${extra.join(", ")} ({{시작일}}·{{종료일}}만 자동)` }, { status: 400 });
    const to = (Array.isArray(s.to) ? s.to : []).map((x) => String(x).trim()).filter(Boolean);
    const bad = to.filter((x) => !EMAIL_RE.test(x));
    if (bad.length) return NextResponse.json({ ok: false, error: `메일 주소가 올바르지 않습니다: ${bad.join(", ")}` }, { status: 400 });
    const rec = await updateSavedReport(id, { schedule: { freq: s.freq, to: to.slice(0, 20), lastSentOn: rep.schedule?.lastSentOn, setBy: user } });
    return NextResponse.json({ ok: true, report: rec });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "정기 발송 설정 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    await deleteSavedReport(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "삭제 실패") }, { status: 500 });
  }
}
