import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { AGENTS, latestVersion, dueTargetKey } from "@/app/lib/agents/registry";
import { getSchedule, getLastTarget, setLastTarget, markTick } from "@/app/lib/agents/schedule";
import { startAgentRun, AgentStartError } from "@/app/lib/agents/run";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // 단계형 에이전트의 한 단계 740초(staged.ts STAGE_MS) + 저장·넘기기. 요청서 에이전트는 그 안에서 270초 기한을 따로 지킨다(Pro + Fluid 한도 800)

// POST — 예약 신호. Supabase pg_cron 이 매시 45분에 두드린다(migration 165, Authorization: Bearer DIGEST_CRON_KEY).
//  에이전트마다 예약 설정(/agents 화면)을 보고 지금이 '목표 시각 15분 전'이면 최신 버전으로 초안을 작성한다.
//  같은 목표 시각은 한 번만(agent_schedule_last). 차례가 아니면 즉시 끝난다 — 설정을 바꿔도 SQL 을 다시 만질 필요가 없다.
//  미들웨어 보호 밖(로그인 쿠키 없이 온다) — 아래 키 검증이 유일한 문이다.
export async function POST(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const ok = [process.env.DIGEST_CRON_KEY, process.env.CRON_SECRET].some((k) => !!k && authz === `Bearer ${k}`);
  if (!ok) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

  await markTick().catch(() => {});
  const now = Date.now();
  const started: string[] = [], skipped: string[] = [];
  const sb = supabaseAdmin();
  for (const a of AGENTS) {
    try {
      const target = dueTargetKey(await getSchedule(a.id), now);
      if (!target) continue;
      if ((await getLastTarget(a.id)) === target) { skipped.push(`${a.id}: 이미 실행`); continue; }
      const { run } = await startAgentRun(sb, { agent: a.id, version: latestVersion(a).id, instruction: null, who: "예약", scheduled: true, origin: req.nextUrl.origin });
      await setLastTarget(a.id, target); // 시작에 성공한 뒤에만 기록(상한·겹침으로 못 시작한 주는 건너뛴다 — 신호는 그 시각대에 한 번뿐)
      after(run);
      started.push(a.id);
    } catch (e) {
      skipped.push(`${a.id}: ${e instanceof AgentStartError || e instanceof Error ? e.message : "오류"}`);
      console.error("[agents/tick]", a.id, e);
    }
  }
  return NextResponse.json({ ok: true, started, skipped });
}
