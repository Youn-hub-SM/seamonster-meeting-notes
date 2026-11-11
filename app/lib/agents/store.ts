// AI 에이전트 보고서 저장소(agent_reports, migration 164) — 서버 전용.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentReport, AgentReportStatus, AppliedItem, DraftItem, AgentToolLog } from "./registry";

export function isPending164(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? "");
  return /agent_reports/.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

// 함수 최대 실행 시간(300초)을 넘긴 '작성 중'은 죽은 실행이다 — 화면에 실패로 보여 준다(행은 그대로 둔다).
export const RUN_STALE_MS = 330_000;

type Row = Record<string, unknown>;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
function toReport(r: Row): AgentReport {
  let status = String(r.status || "running") as AgentReportStatus;
  let error = (r.error as string | null) ?? null;
  if (status === "running" && Date.now() - Date.parse(String(r.created_at)) > RUN_STALE_MS) {
    status = "error"; error = "작성이 끝나지 않고 멈췄습니다. [업무 요청]을 다시 누르세요.";
  }
  return {
    id: String(r.id), agent: String(r.agent), version: String(r.version), status,
    instruction: (r.instruction as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    body_md: (r.body_md as string | null) ?? null,
    draft: arr<DraftItem>(r.draft),
    facts: (r.facts as AgentReport["facts"]) ?? null,
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

// 같은 에이전트가 지금 작성 중인가(겹쳐 실행 방지) — 살아 있는 running 행의 id.
export async function runningReportId(sb: SupabaseClient, agent: string): Promise<string | null> {
  const since = new Date(Date.now() - RUN_STALE_MS).toISOString();
  const { data, error } = await sb.from("agent_reports").select("id").eq("agent", agent).eq("status", "running").gte("created_at", since).limit(1);
  if (error) throw error;
  return (data?.[0]?.id as string | undefined) ?? null;
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

// 다음 실행의 참고 사례 — 같은 에이전트의 최근 완료 보고서(제안·확정·평가). 버전은 가리지 않는다(평가는 일에 대한 것).
export type PriorCase = { date: string; version: string; summary: string | null; draft: { sku: string; name: string; qty: number }[]; applied: { sku: string; qty: number; draft_qty: number | null }[] | null; feedback: string | null };
export async function priorCases(sb: SupabaseClient, agent: string, limit = 4): Promise<PriorCase[]> {
  const { data, error } = await sb.from("agent_reports").select("created_at, version, summary, draft, applied, feedback")
    .eq("agent", agent).eq("status", "done").order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return ((data ?? []) as Row[]).map((r) => ({
    date: new Date(Date.parse(String(r.created_at)) + 9 * 3600e3).toISOString().slice(0, 10),
    version: String(r.version), summary: (r.summary as string | null) ?? null,
    draft: arr<DraftItem>(r.draft).map((d) => ({ sku: d.sku, name: d.name, qty: d.qty })),
    applied: r.applied == null ? null : arr<AppliedItem>(r.applied).map((a) => ({ sku: a.sku, qty: a.qty, draft_qty: a.draft_qty })),
    feedback: (r.feedback as string | null) ?? null,
  }));
}

export async function saveFeedback(sb: SupabaseClient, id: string, feedback: string, who: string | null): Promise<void> {
  const text = feedback.trim().slice(0, 2000);
  const { error } = await sb.from("agent_reports").update({ feedback: text || null, feedback_by: text ? who : null, feedback_at: text ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw error;
}

export async function markApplied(sb: SupabaseClient, id: string, p: { request_id: string; request_no: string | null; applied: AppliedItem[]; who: string | null }): Promise<void> {
  const { error } = await sb.from("agent_reports").update({ request_id: p.request_id, request_no: p.request_no, applied: p.applied, applied_by: p.who, applied_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function deleteReport(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from("agent_reports").delete().eq("id", id);
  if (error) throw error;
}
