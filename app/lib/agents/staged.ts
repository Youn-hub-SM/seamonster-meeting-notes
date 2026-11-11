// 단계로 나눠 도는 에이전트의 공통 실행기 — 서버 전용.
//  왜: Vercel 함수 한 번에는 시간 한도가 있다(이 프로젝트는 Pro + Fluid 라 라우트가 maxDuration 800 까지 선언할 수 있다).
//   조사가 긴 에이전트(웹 조사 + 분석 + 작성)를 품질 우선(생각 강도 high)으로 돌리면 한 번에 못 끝낸다.
//  어떻게: 일을 단계로 자르고, 단계가 끝날 때마다 결과(조사 요약·비용·진행)를 agent_reports 행에 적은 뒤
//   다음 단계를 '새 함수 호출'(/api/agents/tick/resume)로 넘긴다. 단계마다 시간이 새로 주어져 전체 길이에 제한이 없다.
//   넘기지 못하면(키 없음·호출 실패) 같은 호출 안에서 남은 시간으로 이어서 돈다 — 로컬 개발은 늘 이 길이다.
//  실패: 그 단계에서 멈추고 앞 단계가 남긴 요약·비용은 행에 남는다.
//  새 단계형 에이전트 = StagedRunner 하나를 만들어 run.ts STAGED 에 등록 + registry.ts 의 stages(이름)와 수를 맞춘다.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentReport, AgentToolLog, AdIdea } from "./registry";
import { getReport, saveStage, failStage } from "./store";
import { addAssistantUsage } from "../assistant";

// 단계형 에이전트를 시작·이어 도는 라우트는 maxDuration = 800 을 선언한다(reports POST·feedback·tick·tick/resume).
//  2026-11-11: 300초 한도에 맞추려고 생각 강도를 낮추다 품질이 떨어져, 대표 결정으로 '품질 우선' — 한도를 800초로 올리고 high 로 돈다.
export const STAGED_FN_MS = 770_000;    // 함수 한 번이 쓸 수 있는 시간(800초 − 응답·저장 여유)
export const STAGE_MS = 740_000;        // 한 단계가 쓸 수 있는 시간
export const STAGED_STALE_MS = 830_000; // '작성 중'이 이보다 오래 그대로면 죽은 실행(화면에 멈춤으로 표시)
const INLINE_MIN_MS = 100_000;          // 다음 단계를 넘기지 못했을 때, 이만큼 남아 있어야 같은 호출에서 이어 돈다

export type StageUsage = { input: number; output: number; rounds: number; tool_calls: number; elapsed_ms: number };
export type StageCtx = {
  sb: SupabaseClient;
  report: AgentReport;                  // 이 단계를 시작할 때의 보고서(앞 단계 요약은 report.facts.notes)
  notes: Record<string, string>;
  deadlineAt: number;
  revise?: { feedback: string; ideas: AdIdea[] }; // 피드백 반영 실행
};
export type StageResult = {
  model: string; usage: StageUsage; est_usd: number;
  note?: { key: string; text: string };  // 다음 단계가 읽을 조사 요약
  counts?: Record<string, number>;
  warnings?: string[];
  tool_log?: AgentToolLog[];
  final?: { summary: string; body_md: string; draft: AdIdea[] }; // 마지막 단계만
};
// 단계가 실패해도 그때까지 쓴 비용을 남기기 위한 오류
export class StageError extends Error {
  partial: { model: string; usage: StageUsage; est_usd: number };
  constructor(message: string, partial: StageError["partial"]) { super(message); this.partial = partial; }
}
export type StagedRunner = {
  stages: ((c: StageCtx) => Promise<StageResult>)[];
  reviseFrom: number;                    // 피드백을 받으면 이 단계부터 다시 돈다(앞 단계 요약은 그대로 쓴다)
};

type Facts = NonNullable<AgentReport["facts"]>;
const sumUsage = (a: AgentReport["usage"], b: StageUsage): NonNullable<AgentReport["usage"]> => ({
  input: (a?.input || 0) + b.input, output: (a?.output || 0) + b.output, rounds: (a?.rounds || 0) + b.rounds,
  tool_calls: (a?.tool_calls || 0) + b.tool_calls, elapsed_ms: (a?.elapsed_ms || 0) + b.elapsed_ms,
});
const usd = (n: number) => Math.round(n * 10000) / 10000;

// 다음 단계를 새 함수 호출로 넘긴다 — 받는 쪽(/api/agents/tick/resume)이 바로 응답하고 after() 로 단계를 돈다.
async function handOff(origin: string | undefined, id: string): Promise<boolean> {
  const key = (process.env.DIGEST_CRON_KEY || process.env.CRON_SECRET || "").trim();
  if (!origin || !key) return false;
  try {
    const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim(); // 미리보기 배포 보호가 켜져 있을 때 서버끼리 호출 통과
    const res = await fetch(`${origin}/api/agents/tick/resume`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) },
      body: JSON.stringify({ id }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && !!j?.ok;
  } catch (e) {
    console.error("[agents/staged] 다음 단계 넘기기 실패", id, e);
    return false;
  }
}

// 보고서 id 의 다음 단계부터 돈다. fnDeadlineAt = 이 함수 호출이 끝나야 하는 시각.
export async function runStages(sb: SupabaseClient, runner: StagedRunner, id: string, o: { origin?: string; fnDeadlineAt: number; scheduled?: boolean }): Promise<void> {
  for (;;) {
    const report = await getReport(sb, id);
    if (!report || report.status !== "running") return;   // 지워졌거나 이미 닫힘(멈춤 판정 포함)
    const total = runner.stages.length;
    const idx = report.facts?.stage?.done ?? 0;
    if (idx >= total) return;
    const revising = !!report.facts?.revising;
    const startedAt = Date.now();
    const base: Facts = { ...(report.facts || {}), stage: { done: idx, total }, run_started: new Date(startedAt).toISOString(), ...(o.scheduled ? { scheduled: true } : {}) };
    const keep = { tool_log: report.tool_log, usage: report.usage, est_usd: report.est_usd || 0, model: report.model };
    await saveStage(sb, id, { ...keep, facts: base });     // 멈춤 판정 시계를 이 단계 시작으로 다시 맞춘다

    let r: StageResult;
    try {
      r = await runner.stages[idx]({
        sb, report, notes: report.facts?.notes || {}, deadlineAt: Math.min(startedAt + STAGE_MS, o.fnDeadlineAt),
        ...(revising ? { revise: { feedback: report.feedback || "", ideas: report.ideas } } : {}),
      });
    } catch (e) {
      console.error("[agents/staged]", report.agent, `단계 ${idx + 1}/${total}`, e);
      const part = e instanceof StageError ? e.partial : null;
      const spent = part?.est_usd || 0;
      await failStage(sb, id, e instanceof Error ? e.message : "작성 실패", {
        facts: base, tool_log: report.tool_log, model: part?.model ?? report.model,
        usage: part ? sumUsage(report.usage, part.usage) : report.usage, est_usd: usd((report.est_usd || 0) + spent),
      }, revising);
      if (spent) await addAssistantUsage(spent);
      return;
    }

    const facts: Facts = {
      ...base,
      stage: { done: idx + 1, total },
      notes: r.note ? { ...(base.notes || {}), [r.note.key]: r.note.text } : base.notes,
      counts: r.counts ? { ...(base.counts || {}), ...r.counts } : base.counts,
      warnings: r.warnings?.length ? [...new Set([...(base.warnings || []), ...r.warnings])] : base.warnings,
      run_started: new Date().toISOString(),
      ...(r.final ? { revising: false, revise_error: undefined } : {}),
    };
    await saveStage(sb, id, {
      facts, model: r.model, tool_log: [...report.tool_log, ...(r.tool_log || [])],
      usage: sumUsage(report.usage, r.usage), est_usd: usd((report.est_usd || 0) + r.est_usd),
      ...(r.final ? { done: r.final } : {}),
    });
    await addAssistantUsage(r.est_usd);
    if (r.final || idx + 1 >= total) return;

    if (await handOff(o.origin, id)) return;               // 다음 단계는 새 함수 호출이 맡는다
    if (o.fnDeadlineAt - Date.now() < INLINE_MIN_MS) {
      await failStage(sb, id, "다음 단계를 시작하지 못했습니다. [업무 요청]을 다시 누르세요.", { facts, tool_log: [...report.tool_log, ...(r.tool_log || [])], model: r.model, usage: sumUsage(report.usage, r.usage), est_usd: usd((report.est_usd || 0) + r.est_usd) }, revising);
      return;
    }
    // 넘기지 못했지만 시간이 남았다 — 같은 호출에서 이어 돈다
  }
}
