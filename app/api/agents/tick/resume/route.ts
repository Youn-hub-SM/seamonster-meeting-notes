import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { getReport } from "@/app/lib/agents/store";
import { resumeAgentRun } from "@/app/lib/agents/run";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 한 단계 250초(STAGE_MS) + 저장·넘기기

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST { id } — 단계형 에이전트의 다음 단계를 새 함수 호출로 돈다(app/lib/agents/staged.ts 가 앞 단계 끝에서 부른다).
//  바로 응답하고 단계는 after() 로 끝까지 돈다. 단계마다 호출이 따로라 에이전트 전체 길이가 함수 300초에 묶이지 않는다.
//  미들웨어 밖(matcher 가 api/agents/tick 아래를 통째로 뺀다) — 아래 키 검증이 유일한 문이다. 키는 예약 신호(/api/agents/tick)와 같다.
export async function POST(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const ok = [process.env.DIGEST_CRON_KEY, process.env.CRON_SECRET].some((k) => !!k && !!k.trim() && authz === `Bearer ${k.trim()}`);
  if (!ok) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id || !UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const sb = supabaseAdmin();
    const report = await getReport(sb, id);
    const run = report && resumeAgentRun(sb, report, req.nextUrl.origin);
    if (!run) return NextResponse.json({ ok: false, error: "이어 돌 단계가 없습니다." }, { status: 409 });
    after(run);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[agents/tick/resume]", err);
    return NextResponse.json({ ok: false, error: "단계를 시작하지 못했습니다." }, { status: 500 });
  }
}
