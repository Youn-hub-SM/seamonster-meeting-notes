// AI 에이전트 보고서 저장소(agent_reports, migration 164) — 서버 전용.
//  보고서 한 장의 흐름: 작성 중(running) → 결재 대기(done, applied 없음) → [결재] 또는 [피드백 보내기]
//   · 결재 = 초안 그대로 요청서 작성(request_id·applied)
//   · 피드백 = 같은 보고서를 다시 running 으로(facts.revising) → 수정본으로 요청서 작성. 실패하면 초안을 남긴 채 결재 대기로 돌아온다.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentReport, AgentReportStatus, AppliedItem, DraftItem, AgentToolLog } from "./registry";

export function isPending164(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? "");
  return /agent_reports/.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

// 함수 최대 실행 시간(300초)을 넘긴 '작성 중'은 죽은 실행이다 — 행은 그대로 두고 화면에만 멈춤으로 보여 준다.
export const RUN_STALE_MS = 330_000;
type Facts = NonNullable<AgentReport["facts"]>;
const startedAt = (r: Record<string, unknown>): number => Date.parse(String((r.facts as Facts | null)?.run_started || r.created_at));

type Row = Record<string, unknown>;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
function toReport(r: Row): AgentReport {
  let status = String(r.status || "running") as AgentReportStatus;
  let error = (r.error as string | null) ?? null;
  let facts = (r.facts as AgentReport["facts"]) ?? null;
  if (status === "running" && Date.now() - startedAt(r) > RUN_STALE_MS) {
    if (facts?.revising) { status = "done"; facts = { ...facts, revising: false, revise_error: "피드백 반영이 끝나지 않고 멈췄습니다. 피드백을 다시 보내거나 결재하세요." }; }
    else { status = "error"; error = "작성이 끝나지 않고 멈췄습니다. [업무 요청]을 다시 누르세요."; }
  }
  return {
    id: String(r.id), agent: String(r.agent), version: String(r.version), status,
    instruction: (r.instruction as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    body_md: (r.body_md as string | null) ?? null,
    draft: arr<DraftItem>(r.draft),
    facts,
    tool_log: arr<AgentToolLog>(r.tool_log),
    model: (r.model as string | null) ?? null,
    usage: (r.usage as AgentReport["usage"]) ?? null,
    est_usd: r.est_usd == null ? null : Number(r.est_usd),
    error,
    created_by: (r.created_by as string | null) ?? null,
    created_at: String(r.created_at),
    finished_at: (r.finished_at as string | null) ?? null,
    request_id: (r.request_id as string | null) ?? null,
    request_no: (r.request_no as string | null) ?? null,
    applied: r.applied == null ? null : arr<AppliedItem>(r.applied),
    applied_by: (r.applied_by as string | null) ?? null,
    applied_at: (r.applied_at as string | null) ?? null,
    feedback: (r.feedback as string | null) ?? null,
    feedback_by: (r.feedback_by as string | null) ?? null,
    feedback_at: (r.feedback_at as string | null) ?? null,
  };
}

export const LIST_LIMIT = 40;
// 목록 — 최신순 LIST_LIMIT 장. before(created_at) 로 더 옛 보고서를 이어 읽는다.
export async function listReports(sb: SupabaseClient, agent: string, before?: string | null): Promise<{ reports: AgentReport[]; more: boolean }> {
  let q = sb.from("agent_reports").select("*").eq("agent", agent).order("created_at", { ascending: false }).limit(LIST_LIMIT + 1);
  if (before) q = q.lt("created_at", before);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  return { reports: rows.slice(0, LIST_LIMIT).map(toReport), more: rows.length > LIST_LIMIT };
}

export async function getReport(sb: SupabaseClient, id: string): Promise<AgentReport | null> {
  const { data, error } = await sb.from("agent_reports").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toReport(data as Row) : null;
}

// 버전별 장수(필터 탭 숫자) — 행 전체를 읽지 않고 version 만.
export async function countByVersion(sb: SupabaseClient, agent: string): Promise<Record<string, number>> {
  const { data, error } = await sb.from("agent_reports").select("version").eq("agent", agent).limit(5000);
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { version: string }[]) out[r.version] = (out[r.version] || 0) + 1;
  return out;
}

// 같은 에이전트가 지금 일하는 중인가(겹쳐 실행 방지) — 살아 있는 running 행의 id. 피드백 반영 중인 행도 센다.
export async function runningReportId(sb: SupabaseClient, agent: string): Promise<string | null> {
  const { data, error } = await sb.from("agent_reports").select("id, created_at, facts").eq("agent", agent).eq("status", "running").limit(20);
  if (error) throw error;
  const live = ((data ?? []) as Row[]).find((r) => Date.now() - startedAt(r) <= RUN_STALE_MS);
  return live ? String(live.id) : null;
}

export async function startReport(sb: SupabaseClient, p: { agent: string; version: string; instruction: string | null; created_by: string | null }): Promise<string> {
  const { data, error } = await sb.from("agent_reports").insert({ agent: p.agent, version: p.version, instruction: p.instruction, created_by: p.created_by, status: "running" }).select("id").single();
  if (error) throw error;
  return String((data as { id: string }).id);
}

export type FinishInput = {
  summary: string; body_md: string; draft: DraftItem[]; facts: AgentReport["facts"]; tool_log: AgentToolLog[];
  model: string; usage: AgentReport["usage"]; est_usd: number;
};
export async function finishReport(sb: SupabaseClient, id: string, r: FinishInput): Promise<void> {
  const { error } = await sb.from("agent_reports").update({ ...r, status: "done", error: null, finished_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}
export async function failReport(sb: SupabaseClient, id: string, message: string, extra?: Partial<Pick<FinishInput, "model" | "usage" | "est_usd" | "tool_log">>): Promise<void> {
  await sb.from("agent_reports").update({ ...(extra || {}), status: "error", error: message.slice(0, 1000), finished_at: new Date().toISOString() }).eq("id", id);
}

// ── 피드백 반영(같은 보고서를 다시 쓴다) ──
// 시작: 피드백을 적고 다시 '작성 중'으로. 첫 초안은 facts.first_draft 에 한 번만 남긴다(수정본과 비교·다음 실행의 사례).
export async function beginRevision(sb: SupabaseClient, r: AgentReport, feedback: string, who: string | null): Promise<void> {
  const facts: Facts = {
    ...(r.facts || {}), revising: true, run_started: new Date().toISOString(), revise_error: undefined,
    first_draft: r.facts?.first_draft ?? r.draft.map((d) => ({ sku: d.sku, name: d.name, qty: d.qty })),
  };
  const { error } = await sb.from("agent_reports").update({ status: "running", feedback: feedback.slice(0, 2000), feedback_by: who, feedback_at: new Date().toISOString(), facts }).eq("id", r.id);
  if (error) throw error;
}
// 끝: 수정본으로 바꾼다. 비용·조회 내역은 첫 작성분에 더한다.
export async function finishRevision(sb: SupabaseClient, prev: AgentReport, r: FinishInput): Promise<void> {
  const u = prev.usage || {}, n = r.usage || {};
  const sum = (a?: number, b?: number) => (a || 0) + (b || 0);
  const { error } = await sb.from("agent_reports").update({
    summary: r.summary, body_md: r.body_md, draft: r.draft, model: r.model,
    tool_log: [...prev.tool_log, ...r.tool_log],
    usage: { input: sum(u.input, n.input), output: sum(u.output, n.output), rounds: sum(u.rounds, n.rounds), tool_calls: sum(u.tool_calls, n.tool_calls), elapsed_ms: sum(u.elapsed_ms, n.elapsed_ms) },
    est_usd: Math.round(((prev.est_usd || 0) + r.est_usd) * 10000) / 10000,
    facts: { ...(r.facts || {}), scheduled: prev.facts?.scheduled, first_draft: prev.facts?.first_draft, revising: false },
    status: "done", error: null, finished_at: new Date().toISOString(),
  }).eq("id", prev.id);
  if (error) throw error;
}
// 실패: 초안은 그대로 두고 결재 대기로 돌린다(사유만 남긴다).
export async function failRevision(sb: SupabaseClient, prev: AgentReport, message: string, addUsd = 0): Promise<void> {
  await sb.from("agent_reports").update({
    status: "done", facts: { ...(prev.facts || {}), revising: false, revise_error: message.slice(0, 500) },
    est_usd: Math.round(((prev.est_usd || 0) + addUsd) * 10000) / 10000,
  }).eq("id", prev.id);
}

// 다음 실행의 참고 사례 — 같은 에이전트의 최근 완료 보고서(첫 초안·확정·피드백). 버전은 가리지 않는다(피드백은 일에 대한 것).
export type PriorCase = { date: string; version: string; summary: string | null; draft: { sku: string; name: string; qty: number }[]; applied: { sku: string; qty: number; draft_qty: number | null }[] | null; feedback: string | null };
export async function priorCases(sb: SupabaseClient, agent: string, limit = 4, exceptId?: string): Promise<PriorCase[]> {
  const { data, error } = await sb.from("agent_reports").select("id, created_at, version, summary, draft, applied, feedback, facts")
    .eq("agent", agent).eq("status", "done").order("created_at", { ascending: false }).limit(limit + 1);
  if (error) return [];
  return ((data ?? []) as Row[]).filter((r) => r.id !== exceptId).slice(0, limit).map((r) => ({
    date: new Date(Date.parse(String(r.created_at)) + 9 * 3600e3).toISOString().slice(0, 10),
    version: String(r.version), summary: (r.summary as string | null) ?? null,
    draft: (r.facts as Facts | null)?.first_draft ?? arr<DraftItem>(r.draft).map((d) => ({ sku: d.sku, name: d.name, qty: d.qty })),
    applied: r.applied == null ? null : arr<AppliedItem>(r.applied).map((a) => ({ sku: a.sku, qty: a.qty, draft_qty: a.draft_qty })),
    feedback: (r.feedback as string | null) ?? null,
  }));
}

// 요청서로 작성됨(request_id 있음) 또는 요청할 품목이 없어 요청서 없이 닫힘(request_id 없음, applied = [])
export async function markApplied(sb: SupabaseClient, id: string, p: { request_id: string | null; request_no: string | null; applied: AppliedItem[]; who: string | null }): Promise<void> {
  const { error } = await sb.from("agent_reports").update({ request_id: p.request_id, request_no: p.request_no, applied: p.applied, applied_by: p.who, applied_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function deleteReport(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from("agent_reports").delete().eq("id", id);
  if (error) throw error;
}
