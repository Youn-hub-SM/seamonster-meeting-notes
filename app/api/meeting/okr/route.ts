import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { extractOkrFromMeeting } from "@/app/lib/claude";
import { okrReadiness, latestCheckinWithStatus, uploadOkrCheckin } from "@/app/lib/okr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // AI 추출 + 아사나 다건 생성

const COOKIE = "b2b_auth";
async function userOf(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

// GET — 로그인 사용자의 OKR 준비 상태 + 최근 체크인 이행률 (회의 정리 화면 상단 카드)
export async function GET(req: NextRequest) {
  try {
    const member = await userOf(req);
    if (!member) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const readiness = await okrReadiness(member);
    const last = readiness.ready ? await latestCheckinWithStatus(member) : null;
    return NextResponse.json({
      ok: true, member, ...readiness,
      last: last ? {
        meetingDate: last.checkin.meeting_date, dueDate: last.checkin.due_date,
        items: last.items, doneCount: last.doneCount, knownCount: last.knownCount,
      } : null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { action: "extract", text } — 편집된 회의록에서 비공개/공개 요약 + 할 일 분리 추출
//      { action: "upload", meetingDate, dueDate?, privateSummary, publicSummary, todos } — 아사나 업로드
export async function POST(req: NextRequest) {
  try {
    const member = await userOf(req);
    if (!member) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const b = (await req.json()) as Record<string, unknown>;

    if (b.action === "extract") {
      const text = String(b.text || "").trim();
      if (text.length < 20) return NextResponse.json({ ok: false, error: "회의록 내용이 너무 짧습니다." }, { status: 400 });
      const r = await extractOkrFromMeeting(text);
      return NextResponse.json({ ok: true, ...r });
    }

    if (b.action === "upload") {
      const meetingDate = String(b.meetingDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) return NextResponse.json({ ok: false, error: "회의일을 입력하세요." }, { status: 400 });
      const dueDate = typeof b.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) ? b.dueDate : null;
      const todosRaw = Array.isArray(b.todos) ? b.todos : [];
      const todos = todosRaw
        .map((t) => ({ text: String((t as { text?: unknown }).text || "").trim(), scope: (t as { scope?: string }).scope === "okr" ? "okr" as const : "personal" as const }))
        .filter((t) => t.text);
      const r = await uploadOkrCheckin({
        member, meetingDate, dueDate,
        privateSummary: String(b.privateSummary || "").trim(),
        publicSummary: String(b.publicSummary || "").trim(),
        todos,
      });
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error || "업로드 실패" }, { status: 400 });
      return NextResponse.json({ ok: true, created: r.created, failed: r.failed, warning: r.error || undefined });
    }

    return NextResponse.json({ ok: false, error: "알 수 없는 요청입니다." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
