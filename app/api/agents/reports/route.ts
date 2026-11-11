import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { agentOf, PENDING_164 } from "@/app/lib/agents/registry";
import { listReports, countByVersion, isPending164 } from "@/app/lib/agents/store";
import { startAgentRun, AgentStartError } from "@/app/lib/agents/run";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 에이전트 기한 270초(AGENT_DEADLINE_MS) + 응답 여유

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET ?agent=&before= — 그 에이전트의 보고서 목록(최신순) + 버전별 장수
export async function GET(req: NextRequest) {
  try {
    const agent = req.nextUrl.searchParams.get("agent") || "";
    if (!agentOf(agent)) return NextResponse.json({ ok: false, error: "없는 에이전트입니다." }, { status: 400 });
    const before = req.nextUrl.searchParams.get("before");
    const sb = supabaseAdmin();
    const [list, counts] = await Promise.all([listReports(sb, agent, before), before ? Promise.resolve(null) : countByVersion(sb, agent)]);
    return NextResponse.json({ ok: true, ...list, counts });
  } catch (err) {
    if (isPending164(err)) return NextResponse.json({ ok: true, reports: [], more: false, counts: {}, pending: PENDING_164 });
    console.error("[agents/reports GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "보고서를 불러오지 못했습니다") }, { status: 500 });
  }
}

// POST { agent, version, instruction? } — 업무 요청([업무 요청] 버튼) = 보고서 작성 시작. '작성 중' 행의 id 를 바로 돌려주고, 작성은 after() 로 끝까지 돈다(창을 닫아도 계속).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { agent?: string; version?: string; instruction?: string };
    const instruction = String(b.instruction || "").trim().slice(0, 1000) || null;
    const { id, run } = await startAgentRun(supabaseAdmin(), { agent: String(b.agent || ""), version: String(b.version || ""), instruction, who: await actor(req), origin: req.nextUrl.origin });
    after(run);
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    if (err instanceof AgentStartError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    if (isPending164(err)) return NextResponse.json({ ok: false, error: PENDING_164 }, { status: 503 });
    console.error("[agents/reports POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "업무를 요청하지 못했습니다") }, { status: 500 });
  }
}
