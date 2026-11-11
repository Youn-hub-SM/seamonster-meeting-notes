// AI 에이전트 실행 — 서버 전용. 등록부(registry.ts)의 에이전트·버전 id 를 실제 실행기에 잇는다.
//  실행 1회 = agent_reports 1행. 먼저 'running' 행을 만들고(화면이 바로 '작성 중'을 본다), 끝나면 done / error 로 닫는다.
//  시작하는 길은 둘: 화면의 [업무 요청] / 예약 시각의 틱(/api/agents/tick — 끝나면 팀즈로 '결재 필요'를 알린다).
//  피드백 반영(startRevision)은 같은 행을 다시 쓰고, 끝나면 수정본으로 요청서를 작성한다.
//  비용은 AI 비서와 같은 월 상한·끄기 스위치를 따른다(getAssistantSettings) — 에이전트 실행도 그 누적에 더한다.
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentOf, versionOf, type AgentReport } from "./registry";
import { startReport, finishReport, failReport, priorCases, runningReportId, beginRevision, finishRevision, failRevision, getReport } from "./store";
import { runWholesaleRequest, WHOLESALE_V1, WHOLESALE_V2, WHOLESALE_V3, AgentRunError, type AgentRunResult, type RunInput } from "./wholesale-request";
import { applyWholesaleDraft } from "./wholesale-apply";
import { getAssistantSettings, getAssistantMonthUsage, addAssistantUsage } from "../assistant";
import { logAgentDraftReady } from "../b2b-activity";
import { getAppBaseUrl } from "../b2b-settings";
import { runStages, STAGED_FN_MS, type StagedRunner } from "./staged";
import { AD_COPY_V2, AD_COPY_V3 } from "./ad-copy";

export const AGENT_DEADLINE_MS = 270_000; // 라우트 maxDuration 300

type Runner = (sb: SupabaseClient, p: RunInput) => Promise<AgentRunResult>;
// 에이전트 id → 버전 id → 실행기. registry.ts 의 versions 와 짝이 맞아야 한다(없으면 그 버전은 실행 불가).
const RUNNERS: Record<string, Record<string, Runner>> = {
  "wholesale-request": {
    v1: (sb, p) => runWholesaleRequest(sb, WHOLESALE_V1, p),
    v2: (sb, p) => runWholesaleRequest(sb, WHOLESALE_V2, p),
    v3: (sb, p) => runWholesaleRequest(sb, WHOLESALE_V3, p),
  },
};

// 단계로 나눠 도는 에이전트(staged.ts) — 단계마다 함수 호출이 따로라 전체 길이에 제한이 없다
const STAGED: Record<string, Record<string, StagedRunner>> = {
  "ad-copy": { v2: AD_COPY_V2, v3: AD_COPY_V3 }, // v1 은 첫 실행에서 시간 초과 — 종료(registry retired), 실행기 없음
};
// 이 함수 호출이 끝나야 하는 시각 — Vercel 밖(로컬 개발)에는 300초 제한이 없어 단계를 한 호출에서 이어 돈다
const fnDeadline = () => Date.now() + (process.env.VERCEL ? STAGED_FN_MS : 30 * 60_000);

export class AgentStartError extends Error { status: number; constructor(m: string, status = 400) { super(m); this.status = status; } }

async function guard(sb: SupabaseClient, agent: string): Promise<void> {
  const [settings, month, busy] = await Promise.all([getAssistantSettings(), getAssistantMonthUsage(), runningReportId(sb, agent)]);
  if (settings.off) throw new AgentStartError("AI 사용이 꺼져 있습니다. 관리자 설정의 AI 칸에서 켜세요.", 403);
  if (month.usd >= settings.capUsd) throw new AgentStartError(`이번 달 AI 비용 상한($${settings.capUsd})에 닿았습니다. 관리자 설정의 AI 칸에서 상한을 올리세요.`, 403);
  if (busy) throw new AgentStartError("이 에이전트가 이미 일하는 중입니다. 끝난 뒤 다시 누르세요.", 409);
}

// 실행 준비 — 검증·상한 확인·'작성 중' 행 생성까지. 돌려준 run() 을 after() 에 넘겨 끝까지 돌린다.
//  scheduled = 예약 틱이 시작한 실행(작성자 '예약', 끝나면 팀즈 알림).
//  origin = 이 요청이 들어온 주소 — 단계형 에이전트가 다음 단계를 같은 배포의 새 함수 호출로 넘길 때 쓴다.
export async function startAgentRun(sb: SupabaseClient, p: { agent: string; version: string; instruction: string | null; who: string | null; scheduled?: boolean; origin?: string }): Promise<{ id: string; run: () => Promise<void> }> {
  const meta = agentOf(p.agent);
  const ver = meta && versionOf(meta, p.version);
  const runner = RUNNERS[p.agent]?.[p.version];
  const staged = STAGED[p.agent]?.[p.version];
  if (!meta || !ver || (!runner && !staged)) throw new AgentStartError("없는 에이전트 또는 버전입니다.");
  if (ver.retired) throw new AgentStartError("더 실행하지 않는 버전입니다. 다른 버전을 고르세요.");
  await guard(sb, p.agent);

  const id = await startReport(sb, { agent: p.agent, version: p.version, instruction: p.instruction, created_by: p.who });
  if (staged) return { id, run: () => runStages(sb, staged, id, { origin: p.origin, fnDeadlineAt: fnDeadline(), scheduled: p.scheduled }) };
  if (!runner) throw new AgentStartError("없는 에이전트 또는 버전입니다.");
  const deadlineAt = Date.now() + AGENT_DEADLINE_MS;
  const run = async () => {
    try {
      const cases = await priorCases(sb, p.agent);
      const r = await runner(sb, { instruction: p.instruction, cases, deadlineAt });
      await finishReport(sb, id, { ...r, facts: { ...(r.facts || {}), scheduled: p.scheduled || undefined } });
      await addAssistantUsage(r.est_usd);
      if (p.scheduled) {
        const base = await getAppBaseUrl();
        const lines = r.draft.map((d) => `· ${d.name}${d.spec ? ` ${d.spec}` : ""} ${d.qty}${d.unit}${d.urgent ? " (급함)" : ""}`);
        await logAgentDraftReady(meta.name, r.summary, [...lines, base ? `${base}/agents` : ""].filter(Boolean).join("\n"));
      }
    } catch (e) {
      console.error("[agents/run]", p.agent, p.version, e);
      const partial = e instanceof AgentRunError ? e.partial : undefined;
      await failReport(sb, id, e instanceof Error ? e.message : "작성 실패", partial);
      if (partial?.est_usd) await addAssistantUsage(partial.est_usd);
    }
  };
  return { id, run };
}

// 멈춘 단계 이어 돌기 — /api/agents/tick/resume 이 부른다(앞 단계가 넘긴 다음 단계).
export function resumeAgentRun(sb: SupabaseClient, report: AgentReport, origin?: string): (() => Promise<void>) | null {
  const staged = STAGED[report.agent]?.[report.version];
  if (!staged || report.status !== "running") return null;
  return () => runStages(sb, staged, report.id, { origin, fnDeadlineAt: fnDeadline() });
}

// 피드백 반영 준비 — 보고서를 다시 '작성 중'으로 돌리고, run() 이 수정본을 받아 요청서까지 작성한다.
//  실패하면 초안은 그대로 두고 결재 대기로 돌아온다(사유는 facts.revise_error).
export async function startRevision(sb: SupabaseClient, report: AgentReport, feedback: string, who: string | null, origin?: string): Promise<{ run: () => Promise<void> }> {
  const staged = STAGED[report.agent]?.[report.version];
  if (staged) {
    // 단계형 — 조사 요약은 그대로 두고 reviseFrom 단계부터 다시 돈다. 실패하면 목록은 남고 사유만 적힌다(staged.ts failStage).
    await guard(sb, report.agent);
    await beginRevision(sb, { ...report, facts: { ...(report.facts || {}), stage: { done: staged.reviseFrom, total: staged.stages.length } } }, feedback, who);
    return { run: () => runStages(sb, staged, report.id, { origin, fnDeadlineAt: fnDeadline() }) };
  }
  const runner = RUNNERS[report.agent]?.[report.version];
  if (!runner) throw new AgentStartError("이 버전은 더 실행할 수 없습니다. [결재]하거나 새로 [업무 요청]하세요.");
  await guard(sb, report.agent);
  await beginRevision(sb, report, feedback, who);
  const deadlineAt = Date.now() + AGENT_DEADLINE_MS;
  const run = async () => {
    try {
      const cases = await priorCases(sb, report.agent, 4, report.id);
      const r = await runner(sb, {
        instruction: report.instruction, cases, deadlineAt,
        revise: { summary: report.summary, feedback, draft: report.draft.map((d) => ({ sku: d.sku, name: d.name, qty: d.qty, reason: d.reason })) },
      });
      await finishRevision(sb, report, r);
      await addAssistantUsage(r.est_usd);
    } catch (e) {
      console.error("[agents/revise]", report.id, e);
      const usd = e instanceof AgentRunError ? e.partial.est_usd : 0;
      await failRevision(sb, report, e instanceof Error ? e.message : "피드백을 반영하지 못했습니다", usd);
      if (usd) await addAssistantUsage(usd);
      return;
    }
    // 수정본 → 요청서. 여기서 실패하면 수정본은 남아 있다(결재 대기) — 담당자가 [결재]로 다시 작성한다.
    try {
      const fresh = await getReport(sb, report.id);
      if (fresh) await applyWholesaleDraft(sb, fresh, who, "피드백 반영");
    } catch (e) {
      console.error("[agents/revise apply]", report.id, e);
      const fresh = await getReport(sb, report.id).catch(() => null);
      if (fresh) await failRevision(sb, fresh, `수정본은 만들었지만 요청서를 작성하지 못했습니다(${e instanceof Error ? e.message : "오류"}). [결재]를 누르면 수정본으로 작성합니다.`);
    }
  };
  return { run };
}
