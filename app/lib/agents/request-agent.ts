// 생산 요청서 에이전트 공용 실행기 — 서버 전용. 도매(wholesale-request.ts)·소매(retail-request.ts) 요청서 에이전트가 같이 쓴다.
//  에이전트마다 다른 것은 둘뿐: 사실을 모으는 법(collect)과 지침(system). 나머지(조사 차례·제출·검증)는 여기 한 곳.
//  사실은 코드가 모으고, 에이전트는 품목·수량·이유를 판단한다. 더 필요한 것은 읽기 전용 도구로 직접 조회.
//  결과는 submit_report 도구 한 번으로 받는다(강제 tool_choice 는 5.x 에서 400 — auto + 지시).
//  요청서가 되는 길은 둘: 담당자가 초안을 [결재]하면 그대로, [피드백 보내기]를 하면 이 실행기가 revise 로 다시 돌아 낸 수정본이 요청서가 된다(request-apply.ts).
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { manualCoreText } from "../ms365-docs";
import { getFeatureModel, effortParams, AiResponseError } from "../ai-model";
import { MODELS } from "../config";
import {
  anthropic, toolDefs, runTool, toolLabel, addUsage, catalogIndex, PRIVATE_NOTE, retryable, strictRejected, withTimeout,
  TOOL_TIMEOUT_MS, SEARCH_TIMEOUT_MS, type ToolCtx, type AskUsage,
} from "../assistant";
import type { DraftItem, AgentToolLog, AgentReport } from "./registry";
import type { PriorCase } from "./store";

export type AgentRunResult = {
  summary: string; body_md: string; draft: DraftItem[]; facts: AgentReport["facts"]; tool_log: AgentToolLog[];
  model: string; usage: NonNullable<AgentReport["usage"]>; est_usd: number;
};
// 실패해도 그때까지의 비용·조회 내역을 남기기 위한 오류
export class AgentRunError extends Error {
  partial: { model: string; usage: NonNullable<AgentReport["usage"]>; est_usd: number; tool_log: AgentToolLog[] };
  constructor(message: string, partial: AgentRunError["partial"]) { super(message); this.partial = partial; }
}

export const r2 = (n: number) => Math.round(n * 100) / 100;
export const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const EFFORT = "medium" as const;
const MAX_ROUNDS = 8;            // 조사 차례 상한(그 뒤엔 제출만)
const MAX_TOKENS = 16000;
const FINAL_RESERVE_MS = 70_000; // 이만큼 남으면 조사를 끝내고 제출하게 한다

// ── 사실(코드가 모은 것) ──
export type ProductRow = { id: string; sku: string | null; name: string; spec: string | null; unit: string | null; active: boolean | null };
// 품목별 근거 숫자(보고서 표에 그대로 싣는다) — 수량·이유는 에이전트가, 이 숫자는 코드가 채운다
export type Basis = { stock: number | null; dailyOut: number; daysLeft: number | null; formula: number; openReq: number; out7: number; out30: number; need: number };
export type Collected = {
  today: string;
  dueDate: string;          // 이번 요청분이 들어오는 날(요청서의 마감)
  nextArrival: string;      // 다음 요청분이 들어오는 날 — 이번 요청이 버텨야 하는 날
  horizonDays: number;      // 오늘 → nextArrival
  leadDays: number;         // 오늘 → dueDate
  modelFacts: Record<string, unknown>;  // 에이전트에게 주는 facts
  rowCount: number;
  bySku: Map<string, Basis>;
  products: Map<string, ProductRow>;    // SKU(대문자) → 품목
  bundleIds: Set<string>;
  warnings: string[];
};
// SKU(대문자) → 품목. 같은 SKU 가 둘이면 사용 중인 품목이 이긴다.
export function productsBySku<T extends ProductRow>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const p of rows) {
    if (!p.sku) continue;
    const k = p.sku.toUpperCase();
    const cur = out.get(k);
    if (!cur || (cur.active === false && p.active !== false)) out.set(k, p);
  }
  return out;
}

export type RequestAgentDef = {
  doc: string;                                           // 만드는 문서 이름(도구 설명·작업 지시에 쓴다)
  system: string;                                        // 지침
  collect: (sb: SupabaseClient) => Promise<Collected>;   // 사실 수집
};

const READ_TOOLS = new Set(["run_sql", "schema", "search_text", "read_report"]);
function agentTools(doc: string, strict: boolean): Anthropic.Tool[] {
  const s = strict ? { strict: true } : {};
  return [
    ...toolDefs(strict).filter((t) => READ_TOOLS.has(t.name)),
    {
      name: "submit_report", ...s,
      description: `${doc} 초안과 보고서를 제출합니다. 조사가 끝나면 정확히 한 번 호출합니다.`,
      input_schema: {
        type: "object", additionalProperties: false, required: ["summary", "items", "body_md"],
        properties: {
          summary: { type: "string", description: "한 문장 요약" },
          items: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["sku", "qty", "reason", "urgent"],
              properties: {
                sku: { type: "string", description: "facts.rows 의 sku 그대로" },
                qty: { type: "number", description: "요청 수량(판매 단위 개수)" },
                reason: { type: "string", description: "이 수량의 이유 한두 문장" },
                urgent: { type: "boolean", description: "급한 품목인가" },
              },
            },
          },
          body_md: { type: "string", description: "보고서 본문(마크다운 — ## 제목, - 목록, **굵게** 만)" },
        },
      },
    },
  ];
}

function casesBlock(cases: PriorCase[]): string {
  if (!cases.length) return "- 없음(첫 보고서)";
  return cases.map((c) => {
    const draft = c.draft.map((d) => `${d.sku} ${d.qty}`).join(", ") || "제안 없음";
    const applied = c.applied == null ? "아직 결재 전"
      : c.applied.map((a) => `${a.sku} ${a.qty}${a.draft_qty == null ? "(초안에 없던 품목)" : a.draft_qty !== a.qty ? `(초안 ${a.draft_qty})` : ""}`).join(", ") || "요청 없이 닫음";
    return `- ${c.date} 요약: ${c.summary || "-"}\n  첫 초안: ${draft}\n  요청서로 확정: ${applied}\n  담당자 피드백: ${c.feedback || "없음(초안 그대로 결재)"}`;
  }).join("\n");
}

type Submit = { summary: string; items: { sku: string; qty: number; reason: string; urgent: boolean }[]; body_md: string };

export type ReviseInput = { summary: string | null; draft: { sku: string; name: string; qty: number; reason: string }[]; feedback: string };
export type RunInput = { instruction: string | null; cases: PriorCase[]; deadlineAt: number; revise?: ReviseInput };

export async function runRequestAgent(sb: SupabaseClient, def: RequestAgentDef, p: RunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const [c, model, index, rules] = await Promise.all([
    def.collect(sb),
    getFeatureModel("agent"),
    catalogIndex(sb),
    manualCoreText(/데이터 해석 기준|용어 정의/).catch(() => ""),
  ]);
  const usage: AskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estUsd: 0, estNote: "" };
  const toolLog: AgentToolLog[] = [];
  let rounds = 0, toolCalls = 0;
  const usageOut = () => ({ input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, rounds, tool_calls: toolCalls, elapsed_ms: Date.now() - startedAt });
  const fail = (m: string) => new AgentRunError(m, { model, usage: usageOut(), est_usd: usage.estUsd, tool_log: toolLog });

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: `${def.system}\n\n[조회 가능 관계(run_sql) — 이름과 한 줄 설명. 컬럼은 schema 도구로 확인]\n${index}\n\n[조회 불가(비공개 — 시도 금지)]\n${PRIVATE_NOTE}`, cache_control: { type: "ephemeral" } },
    { type: "text", text: rules ? `[회사 해석 기준 — 셰어포인트 '[비서]' 페이지 본문 그대로]\n${rules}` : "[회사 해석 기준] 셰어포인트 매뉴얼을 읽지 못했습니다. 회사 규칙을 확인하지 못했다고 '확인 필요'에 적습니다.", cache_control: { type: "ephemeral" } },
  ];
  // 피드백 반영이면 첫 초안과 피드백을 함께 준다 — 제출한 수정본은 그대로 요청서가 된다
  const task = p.revise
    ? `담당자 피드백을 반영한 ${def.doc} 수정본을 submit_report 로 제출하세요. 제출한 수정본은 그대로 요청서가 됩니다.`
    : `${def.doc} 초안을 작성해 submit_report 로 제출하세요.`;
  const revised = p.revise
    ? `[담당자 피드백]\n${p.revise.feedback}\n\n[당신이 낸 초안]\n요약: ${p.revise.summary || "-"}\n${p.revise.draft.map((d) => `- ${d.sku} ${d.name} ${d.qty} — ${d.reason}`).join("\n") || "- 품목 없음"}\n\n`
    : "";
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: [{
      type: "text", cache_control: { type: "ephemeral" },
      text: `${task}\n\n${revised}[덧붙인 말]\n${p.instruction || "없음"}\n\n[지난 보고서 — 최신순]\n${casesBlock(p.cases)}\n\n[facts — 방금 계산한 값]\n${JSON.stringify(c.modelFacts)}`,
    }],
  }];

  const ctx: ToolCtx = { sb, question: `${def.doc} 초안 작성`, sqlRuns: [], usage, auxModel: MODELS.opus, deadlineAt: p.deadlineAt };
  let strict = true, tools = agentTools(def.doc, true), retried = false, nudged = 0;
  let submitted: Submit | null = null;

  while (!submitted) {
    const left = p.deadlineAt - Date.now();
    if (left < 20_000) throw fail("작성 시간이 부족해 보고서를 완성하지 못했습니다. [업무 요청]을 다시 누르세요.");
    const closing = rounds >= MAX_ROUNDS || left < FINAL_RESERVE_MS + 30_000; // 조사 끝 — 제출만 받는다
    if (rounds >= MAX_ROUNDS + 3) throw fail("에이전트가 결과를 제출하지 않았습니다. [업무 요청]을 다시 누르세요.");
    let res: Anthropic.Message;
    try {
      res = await anthropic.messages.create({
        model, max_tokens: MAX_TOKENS, system, messages, tools, tool_choice: { type: "auto" },
        ...effortParams(model, EFFORT),
      }, { timeout: Math.min(180_000, left - 10_000), maxRetries: 0 });
    } catch (e) {
      if (strict && strictRejected(e)) { strict = false; tools = agentTools(def.doc, false); continue; }
      if (!retried && retryable(e) && p.deadlineAt - Date.now() > FINAL_RESERVE_MS) { retried = true; await new Promise((r) => setTimeout(r, 3000)); continue; }
      throw fail(e instanceof Error ? `AI 호출 실패: ${e.message}` : "AI 호출 실패");
    }
    rounds++;
    addUsage(usage, model, res.usage);
    if (res.stop_reason === "refusal") throw fail("AI 안전 필터가 응답을 거절했습니다. 덧붙인 말을 바꿔 다시 시도하세요.");
    if (res.stop_reason === "max_tokens") throw fail("AI 결과가 길어 중간에 잘렸습니다. [업무 요청]을 다시 누르세요.");

    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: res.content }); // thinking·tool_use 블록 그대로
    if (!uses.length) {
      // 글로만 끝냈다 — 제출을 다시 청한다(두 번까지)
      if (++nudged > 2) throw fail("에이전트가 결과를 제출하지 않았습니다. [업무 요청]을 다시 누르세요.");
      messages.push({ role: "user", content: "보고서는 submit_report 도구로 제출해야 합니다. 지금까지 판단한 내용으로 submit_report 를 호출하세요." });
      continue;
    }
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(uses.map(async (u) => {
      const input = (u.input || {}) as Record<string, unknown>;
      if (u.name === "submit_report") {
        const s = input as unknown as Submit;
        if (typeof s.summary !== "string" || !Array.isArray(s.items) || typeof s.body_md !== "string")
          return { type: "tool_result" as const, tool_use_id: u.id, content: "오류: summary(글)·items(배열)·body_md(글)가 모두 있어야 합니다. 다시 제출하세요.", is_error: true };
        submitted = s;
        return { type: "tool_result" as const, tool_use_id: u.id, content: "제출되었습니다." };
      }
      if (closing) return { type: "tool_result" as const, tool_use_id: u.id, content: "조사 시간이 끝났습니다. 지금까지 확인한 내용으로 submit_report 를 호출하세요.", is_error: true };
      toolCalls++;
      const title = toolLabel(u.name, input);
      const sql = u.name === "run_sql" ? String(input.sql || "").slice(0, 4000) : undefined;
      try {
        const out = await withTimeout(runTool(ctx, u.name, input), u.name === "search_text" ? SEARCH_TIMEOUT_MS : TOOL_TIMEOUT_MS);
        if (out === "timeout") throw new Error("조회 시간 초과");
        toolLog.push({ name: u.name, title, sql, ok: true });
        return { type: "tool_result" as const, tool_use_id: u.id, content: out };
      } catch (e) {
        toolLog.push({ name: u.name, title, sql, ok: false });
        return { type: "tool_result" as const, tool_use_id: u.id, content: `오류: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    }));
    if (submitted) break;
    messages.push({ role: "user", content: results });
  }

  // ── 제출 검증 — 수량·이유는 에이전트, 근거 숫자·품목 정보는 코드 값으로 채운다 ──
  const s = submitted as Submit;
  const warnings = [...c.warnings];
  const seen = new Set<string>();
  const draft: DraftItem[] = [];
  for (const it of s.items) {
    const sku = String(it.sku || "").trim().toUpperCase();
    const qty = r2(Number(it.qty) || 0);
    if (!sku || qty <= 0 || seen.has(sku)) continue;
    seen.add(sku);
    const f = c.bySku.get(sku);
    const prod = c.products.get(sku);
    if (!prod) { warnings.push(`${sku}: 상품 마스터에 없는 SKU 라 제안에서 뺐습니다.`); continue; }
    if (c.bundleIds.has(prod.id)) { warnings.push(`${sku}: 묶음(세트) 품목은 요청서에 담을 수 없어 뺐습니다.`); continue; }
    if (prod.active === false) warnings.push(`${sku}: 미사용 품목입니다.`);
    draft.push({
      sku, product_id: prod.id, name: prod.name, spec: prod.spec, unit: prod.unit || "개",
      qty, reason: String(it.reason || "").trim().slice(0, 600), urgent: !!it.urgent,
      wholesale_stock: f?.stock ?? null, daily_out: r2(f?.dailyOut ?? 0), days_left: f?.daysLeft ?? null,
      formula: f?.formula ?? 0, open_req: f?.openReq ?? 0,
      ...(f ? { out7: f.out7, out30: f.out30, need: f.need } : {}),
    });
  }
  const summary = s.summary.trim().slice(0, 300);
  const body_md = s.body_md.trim().slice(0, 12000);
  if (!summary && !body_md) throw fail(new AiResponseError("AI 가 빈 보고서를 돌려주었습니다.").message);

  return {
    summary, body_md, draft, tool_log: toolLog, model, usage: usageOut(), est_usd: usage.estUsd,
    facts: { today: c.today, horizon_days: c.horizonDays, lead_days: c.leadDays, due_date: c.dueDate, rows: c.rowCount, warnings, next_arrival: c.nextArrival },
  };
}
