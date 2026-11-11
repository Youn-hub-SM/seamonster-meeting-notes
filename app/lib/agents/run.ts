// AI 에이전트 실행 — 서버 전용. 등록부(registry.ts)의 에이전트·버전 id 를 실제 실행기에 잇는다.
//  실행 1회 = agent_reports 1행. 먼저 'running' 행을 만들고(화면이 바로 '작성 중'을 본다), 끝나면 done / error 로 닫는다.
//  비용은 AI 비서와 같은 월 상한·끄기 스위치를 따른다(getAssistantSettings) — 에이전트 실행도 그 누적에 더한다.
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentOf, versionOf } from "./registry";
import { startReport, finishReport, failReport, priorCases, runningReportId } from "./store";
import { runWholesaleRequest, WHOLESALE_V1, AgentRunError, type AgentRunResult } from "./wholesale-request";
import { getAssistantSettings, getAssistantMonthUsage, addAssistantUsage } from "../assistant";
import type { PriorCase } from "./store";

export const AGENT_DEADLINE_MS = 270_000; // 라우트 maxDuration 300

type Runner = (sb: SupabaseClient, p: { instruction: string | null; cases: PriorCase[]; deadlineAt: number }) => Promise<AgentRunResult>;
// 에이전트 id → 버전 id → 실행기. registry.ts 의 versions 와 짝이 맞아야 한다(없으면 그 버전은 실행 불가).
const RUNNERS: Record<string, Record<string, Runner>> = {
  "wholesale-request": {
    v1: (sb, p) => runWholesaleRequest(sb, WHOLESALE_V1, p),
  },
};

export class AgentStartError extends Error { status: number; constructor(m: string, status = 400) { super(m); this.status = status; } }

// 실행 준비 — 검증·상한 확인·'작성 중' 행 생성까지. 돌려준 run() 을 after() 에 넘겨 끝까지 돌린다.
export async function startAgentRun(sb: SupabaseClient, p: { agent: string; version: string; instruction: string | null; who: string | null }): Promise<{ id: string; run: () => Promise<void> }> {
  const meta = agentOf(p.agent);
  const ver = meta && versionOf(meta, p.version);
  const runner = RUNNERS[p.agent]?.[p.version];
  if (!meta || !ver || !runner) throw new AgentStartError("없는 에이전트 또는 버전입니다.");
  if (ver.retired) throw new AgentStartError("더 실행하지 않는 버전입니다. 다른 버전을 고르세요.");

  const [settings, month, busy] = await Promise.all([getAssistantSettings(), getAssistantMonthUsage(), runningReportId(sb, p.agent)]);
  if (settings.off) throw new AgentStartError("AI 사용이 꺼져 있습니다. 관리자 설정의 AI 칸에서 켜세요.", 403);
  if (month.usd >= settings.capUsd) throw new AgentStartError(`이번 달 AI 비용 상한($${settings.capUsd})에 닿았습니다. 관리자 설정의 AI 칸에서 상한을 올리세요.`, 403);
  if (busy) throw new AgentStartError("이 에이전트가 이미 보고서를 작성 중입니다. 끝난 뒤 다시 누르세요.", 409);

  const id = await startReport(sb, { agent: p.agent, version: p.version, instruction: p.instruction, created_by: p.who });
  const deadlineAt = Date.now() + AGENT_DEADLINE_MS;
  const run = async () => {
    try {
      const cases = await priorCases(sb, p.agent);
      const r = await runner(sb, { instruction: p.instruction, cases, deadlineAt });
      await finishReport(sb, id, r);
      await addAssistantUsage(r.est_usd);
    } catch (e) {
      console.error("[agents/run]", p.agent, p.version, e);
      const partial = e instanceof AgentRunError ? e.partial : undefined;
      await failReport(sb, id, e instanceof Error ? e.message : "작성 실패", partial);
      if (partial?.est_usd) await addAssistantUsage(partial.est_usd);
    }
  };
  return { id, run };
}
