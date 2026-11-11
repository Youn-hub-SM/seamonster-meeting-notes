import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getReport } from "@/app/lib/agents/store";
import { startRevision, AgentStartError } from "@/app/lib/agents/run";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 에이전트 기한 270초 + 요청서 작성

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST { feedback } — 피드백 보내기. 에이전트가 피드백대로 초안을 고치고, 그 수정본이 실제 도매 생산 요청서로 작성된다.
//  보고서를 바로 '피드백 반영 중'으로 돌려 응답하고, 반영·작성은 after() 로 끝까지 돈다(창을 닫아도 계속).
//  반영에 실패하면 초안은 그대로 남고 결재 대기로 돌아온다.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const b = (await req.json()) as { feedback?: string };
    const feedback = String(b.feedback || "").trim().slice(0, 2000);
    if (!feedback) return NextResponse.json({ ok: false, error: "피드백을 입력하세요." }, { status: 400 });
    const sb = supabaseAdmin();
    const report = await getReport(sb, id);
    if (!report) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    if (report.agent !== "wholesale-request") return NextResponse.json({ ok: false, error: "피드백을 받을 수 없는 보고서입니다." }, { status: 400 });
    if (report.status !== "done") return NextResponse.json({ ok: false, error: "작성이 끝난 초안에만 피드백을 보낼 수 있습니다." }, { status: 409 });
    if (report.applied) return NextResponse.json({ ok: false, error: "이미 요청서로 작성한 보고서입니다. 요청서는 생산 요청 화면에서 고치세요." }, { status: 409 });

    const token = req.cookies.get("b2b_auth")?.value;
    const who = (await verifySession(token)) || resolveUserName(token);
    const { run } = await startRevision(sb, report, feedback, who);
    after(run);
    return NextResponse.json({ ok: true, report: await getReport(sb, id) });
  } catch (err) {
    if (err instanceof AgentStartError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    console.error("[agents/feedback POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "피드백을 보내지 못했습니다") }, { status: 500 });
  }
}
