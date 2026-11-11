// 도매 생산 요청서 에이전트 — 서버 전용.
//  도매 생산 요청서(용도 '도매 납품') = 소매 칸 재고를 도매 칸으로 옮겨 달라는 요청. 이행은 재고 이동이지 제조사 생산이 아니다.
//  사실(재고·속도·이미 낸 요청·소매 여유)은 코드가 모으고, 에이전트는 품목·수량·이유를 판단한다. 더 필요한 것은 읽기 전용 도구로 직접 조회.
//  결과는 submit_report 도구 한 번으로 받는다(강제 tool_choice 는 5.x 에서 400 — auto + 지시). 요청서 생성은 사람이 화면에서 한다.
//  버전 = WholesaleConfig 하나. 새 버전은 설정을 하나 더 만들어 run.ts 에 등록한다(옛 버전 설정은 지우지 않는다).
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInventoryRows, type InvRow } from "../production-inventory";
import { loadRequests } from "../wholesale-production-db";
import { defaultDueDate, kstTodayIso } from "../production-schedule";
import { readAll } from "../inventory-template";
import { manualCoreText } from "../ms365-docs";
import { getFeatureModel, effortParams, AiResponseError } from "../ai-model";
import { MODELS } from "../config";
import {
  anthropic, toolDefs, runTool, toolLabel, addUsage, catalogIndex, PRIVATE_NOTE, kstTodayLabel, retryable, strictRejected, withTimeout,
  TOOL_TIMEOUT_MS, SEARCH_TIMEOUT_MS, type ToolCtx, type AskUsage,
} from "../assistant";
import type { DraftItem, AgentToolLog, AgentReport } from "./registry";
import type { PriorCase } from "./store";

export type WholesaleConfig = {
  system: string;                       // 버전의 지침
  effort: "low" | "medium" | "high";
  maxRounds: number;                    // 조사 차례 상한(그 뒤엔 제출만)
};
export type AgentRunResult = {
  summary: string; body_md: string; draft: DraftItem[]; facts: AgentReport["facts"]; tool_log: AgentToolLog[];
  model: string; usage: NonNullable<AgentReport["usage"]>; est_usd: number;
};
// 실패해도 그때까지의 비용·조회 내역을 남기기 위한 오류
export class AgentRunError extends Error {
  partial: { model: string; usage: NonNullable<AgentReport["usage"]>; est_usd: number; tool_log: AgentToolLog[] };
  constructor(message: string, partial: AgentRunError["partial"]) { super(message); this.partial = partial; }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const MAX_TOKENS = 16000;
const FINAL_RESERVE_MS = 70_000; // 이만큼 남으면 조사를 끝내고 제출하게 한다

// ── 사실 수집(코드) ──
type P = { id: string; sku: string | null; name: string; spec: string | null; unit: string | null; active: boolean | null };
type FactRow = {
  sku: string; 품목: string; 도매재고: number | null; 도매하루출고: number; 버티는일수: number | null; 목표: number; 부족기준: number;
  수식권장: number; 이미요청: number; 소매재고: number | null; 소매하루출고: number; 소매부족기준: number; 소매입고예정: number; 소매여유: number | null;
};
type Collected = {
  today: string; dueDate: string | null; horizonDays: number; leadDays: number;
  rows: FactRow[]; bySku: Map<string, { w: InvRow; r: InvRow | undefined; p: P | undefined; spare: number | null; daysLeft: number | null }>;
  products: Map<string, P>; bundleIds: Set<string>;
  openRequests: unknown[]; openOrders: unknown[]; warnings: string[];
};

async function collect(sb: SupabaseClient): Promise<Collected> {
  const today = kstTodayIso();
  const warnings: string[] = [];
  const [wh, rt, prodRows, bundles, reqA, reqB, orders] = await Promise.all([
    getInventoryRows("도매"),
    getInventoryRows("소매"),
    readAll<P>((a, b) => sb.from("products").select("id, sku, name, spec, unit, active").order("id", { ascending: true }).range(a, b)),
    sb.from("product_bundles").select("parent_id").limit(5000),
    loadRequests(sb, { status: "요청" }),
    loadRequests(sb, { status: "진행중" }),
    sb.from("orders").select("order_no, order_date, ship_date, is_bulk, companies(name), order_items(product_id, product_name, qty)")
      .eq("status", "발송대기").order("ship_date", { ascending: true, nullsFirst: false }).limit(200),
  ]);
  if (!wh.wholesaleReqOk) warnings.push("이미 낸 도매 요청 잔여를 집계하지 못했습니다 — 수식 권장이 이미 요청한 양을 빼지 못한 값입니다.");
  if (!rt.inboundOk) warnings.push("소매 입고 예정을 집계하지 못했습니다.");
  if (!rt.settingsOk) warnings.push("행사 일정·안전재고 보정을 읽지 못해 소매 수치에 빠졌습니다.");

  // SKU(대문자) → 품목. 같은 SKU 가 둘이면 사용 중인 품목이 이긴다.
  const products = new Map<string, P>();
  for (const p of prodRows) {
    if (!p.sku) continue;
    const k = p.sku.toUpperCase();
    const cur = products.get(k);
    if (!cur || (cur.active === false && p.active !== false)) products.set(k, p);
  }
  const bundleIds = new Set<string>(((bundles.data ?? []) as { parent_id: string }[]).map((b) => b.parent_id));
  const idToSku = new Map<string, string>();
  for (const p of prodRows) if (p.sku) idToSku.set(p.id, p.sku.toUpperCase());

  const retailBySku = new Map(rt.rows.map((r) => [r.sku, r]));
  const bySku: Collected["bySku"] = new Map();
  const rows: FactRow[] = [];
  for (const w of wh.rows) {
    const r = retailBySku.get(w.sku);
    const spare = r && r.stock != null ? Math.max(0, r2(r.stock - r.leadSafety)) : null;
    const daysLeft = w.stock != null && w.dailyOut > 0 ? Math.floor(Math.max(0, w.stock) / w.dailyOut) : null;
    bySku.set(w.sku, { w, r, p: products.get(w.sku), spare, daysLeft });
    // 움직임이 전혀 없는 품목(재고 0·출고 0·요청 0)은 판단 대상이 아니다 — 토큰만 쓴다
    if (!(w.recommendGross > 0 || w.wholesaleReq > 0 || w.dailyOut > 0 || (w.stock ?? 0) !== 0)) continue;
    rows.push({
      sku: w.sku, 품목: w.name, 도매재고: w.stock, 도매하루출고: r2(w.dailyOut), 버티는일수: daysLeft, 목표: w.safety, 부족기준: w.leadSafety,
      수식권장: w.recommendNet, 이미요청: w.wholesaleReq,
      소매재고: r?.stock ?? null, 소매하루출고: r2(r?.dailyOut ?? 0), 소매부족기준: r?.leadSafety ?? 0, 소매입고예정: r?.inbound ?? 0, 소매여유: spare,
    });
  }
  rows.sort((a, b) => b.수식권장 - a.수식권장 || (a.버티는일수 ?? 9999) - (b.버티는일수 ?? 9999) || a.sku.localeCompare(b.sku));

  const openRequests = [...reqA, ...reqB].filter((q) => q.purpose === "도매 납품").map((q) => ({
    요청번호: q.req_no, 상태: q.status === "진행중" ? "확정" : "확정 필요", 요청일: q.request_date, 마감: q.due_date, 제목: q.title, 메모: q.memo,
    품목: q.items.map((it) => ({ sku: it.sku, 품목: it.name, 요청: it.requested_qty, 이동완료: it.received_qty, 잔여: r2(Math.max(0, it.requested_qty - it.received_qty)) })),
  }));

  if (orders.error) warnings.push("발송 대기 B2B 발주를 읽지 못했습니다.");
  type O = { order_no: string; order_date: string; ship_date: string | null; is_bulk: boolean | null; companies: { name?: string } | { name?: string }[] | null; order_items: { product_id: string | null; product_name: string; qty: number }[] };
  const openOrders = ((orders.data ?? []) as unknown as O[]).map((o) => ({
    발주번호: o.order_no, 발주일: o.order_date, 발송예정일: o.ship_date, 대량: !!o.is_bulk,
    거래처: (Array.isArray(o.companies) ? o.companies[0]?.name : o.companies?.name) ?? null,
    품목: (o.order_items ?? []).map((it) => ({ sku: it.product_id ? idToSku.get(it.product_id) ?? null : null, 품목: it.product_name, 수량: Number(it.qty) || 0 })),
  }));

  return {
    today, dueDate: defaultDueDate("도매 납품", today), horizonDays: wh.horizonDays, leadDays: wh.leadDays,
    rows, bySku, products, bundleIds, openRequests, openOrders, warnings,
  };
}

// ── 지침(버전별) ──
export const SYSTEM_V1 = `당신은 씨몬스터(냉동 순살 생선 — 공식몰·스마트스토어·쿠팡 소매와 B2B 도매)의 '도매 생산 요청서' 담당 에이전트입니다.

[맡은 일]
도매 담당자가 쓰는 '도매 생산 요청서'의 초안을 만듭니다. 이 요청서는 제조사에 새 생산을 시키는 문서가 아니라, 소매 칸에 있는 재고를 도매 칸으로 옮겨 달라는 요청입니다(이행 = 소매에서 도매로 재고 이동). 당신은 요청서를 직접 만들지 않습니다. 사람이 초안을 확인하고 고쳐 요청서로 만듭니다.

[할 수 있는 일의 범위]
이 에이전트가 할 수 있는 일은 도매 생산 요청서 초안 작성 하나뿐입니다. 제조사 생산 요청서, 프로모션·도매 대량 요청서, 다른 보고서나 분석, 질문에 대한 답은 맡은 일이 아닙니다. 덧붙인 말이 그런 일을 시키면 하지 않고, '확인 필요'에 "(시킨 일)은 이 에이전트가 하는 일이 아닙니다"라고 한 줄 적은 뒤 도매 생산 요청서 초안만 작성합니다. 조회 도구도 이 초안의 품목과 수량을 판단하는 데에만 씁니다.

[받는 자료]
- facts: 코드가 방금 계산한 사실입니다. 숫자는 이 값을 그대로 씁니다.
  · rows: 품목별 도매재고(발송일이 잡힌 B2B 선점까지 이미 뺀 가용 재고), 도매하루출고(최근 평균), 버티는일수, 목표(= 도매하루출고 × 목표일수), 부족기준, 수식권장(= max(0, 목표 − 도매재고) − 이미요청), 이미요청(열려 있는 도매 요청서의 잔여), 소매재고, 소매하루출고, 소매부족기준, 소매입고예정, 소매여유(= 소매재고 − 소매부족기준, 옮겨도 소매가 부족해지지 않는 양).
  · open_requests: 열려 있는 도매 요청서. open_orders: 발송 대기 중인 B2B 발주.
- 회사 해석 기준: 생산 요청에 관한 회사 규칙이 있으면 그대로 따릅니다.
- 지난 보고서: 당신(또는 이전 버전)이 낸 제안, 사람이 확정한 수량, 사람의 평가입니다. 사람이 고친 방향과 평가를 같은 상황에 적용합니다.
- 덧붙인 말: 이번 요청에 사람이 준 정보나 지시입니다. 도매 생산 요청서의 품목과 수량에 관한 것이면 다른 기준보다 우선합니다.

[판단 기준]
1. 출발점은 수식권장입니다. 수식권장이 0인 품목은 특별한 이유(덧붙인 말, 발송 대기 발주, 회사 규칙)가 있을 때만 넣습니다.
2. 이미요청이 있는 품목은 그만큼 이미 요청된 것입니다. 같은 양을 다시 요청하지 않습니다.
3. 소매여유를 넘는 수량은 소매 판매를 막습니다. 수량은 소매여유 안에서 정하고, 모자라는 양은 '확인 필요'에 제조사 생산이 필요하다고 적습니다. 소매여유가 null 이면 소매 재고가 없는 품목이니 넣지 않고 '확인 필요'에 적습니다.
4. 도매재고는 발송일이 잡힌 선점을 이미 뺀 값입니다. open_orders 의 수량을 다시 빼지 않습니다. 발송예정일이 없는 발주처럼 아직 선점되지 않았을 수 있는 수요는 필요하면 조회로 확인합니다.
5. 버티는일수가 부족기준 일수보다 짧은 품목은 급한 품목(urgent)입니다.
6. 수량은 품목의 판매 단위 개수(정수)입니다. 근거 없이 올림·내림하지 않습니다.
7. 확인하지 못한 것은 추측으로 채우지 않고 '확인 필요'에 적습니다.

[도구]
- schema, run_sql: 읽기 전용 조회입니다. facts 로 판단이 서면 쓰지 않습니다. 특정 품목의 최근 출고 추이, 거래처별 발주 주기, 선점 여부처럼 판단이 갈리는 것만 확인합니다(보통 0~4회).
- search_text, read_report: 요청서 메모·종합 리포트 본문이 필요할 때.
- submit_report: 결과 제출. 마지막에 정확히 한 번 호출합니다. 글로만 답하고 끝내지 않습니다.

[제출 형식]
- summary: 한 문장. 품목 수와 가장 중요한 판단.
- items: 요청할 품목. sku 는 facts 의 sku 그대로, qty 는 수량, reason 은 한두 문장(근거 숫자 포함), urgent 는 급함 여부.
- body_md: 아래 틀. '##' 제목, '-' 목록, '**굵게**' 만 씁니다(표·코드 블록 없음). 날짜는 '이번 주' 같은 말 대신 실제 날짜로 적습니다.

## 판단 근거
- (전체 상황과 수량을 정한 원칙)
## 요청하지 않은 품목
- (수식권장이 있었지만 넣지 않았거나 줄인 품목과 이유. 없으면 이 제목을 뺍니다)
## 확인 필요
- (사람이 확인할 것. 없으면 이 제목을 뺍니다)`;

export const WHOLESALE_V1: WholesaleConfig = { system: SYSTEM_V1, effort: "medium", maxRounds: 8 };

const READ_TOOLS = new Set(["run_sql", "schema", "search_text", "read_report"]);
function agentTools(strict: boolean): Anthropic.Tool[] {
  const s = strict ? { strict: true } : {};
  return [
    ...toolDefs(strict).filter((t) => READ_TOOLS.has(t.name)),
    {
      name: "submit_report", ...s,
      description: "도매 생산 요청서 초안과 보고서를 제출합니다. 조사가 끝나면 정확히 한 번 호출합니다.",
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
    const applied = c.applied == null ? "요청서로 만들지 않음"
      : c.applied.map((a) => `${a.sku} ${a.qty}${a.draft_qty == null ? "(사람이 추가)" : a.draft_qty !== a.qty ? `(제안 ${a.draft_qty})` : ""}`).join(", ") || "품목 없이 닫음";
    return `- ${c.date} (${c.version}) 요약: ${c.summary || "-"}\n  제안: ${draft}\n  사람이 확정: ${applied}\n  평가: ${c.feedback || "없음"}`;
  }).join("\n");
}

type Submit = { summary: string; items: { sku: string; qty: number; reason: string; urgent: boolean }[]; body_md: string };

export async function runWholesaleRequest(sb: SupabaseClient, cfg: WholesaleConfig, p: { instruction: string | null; cases: PriorCase[]; deadlineAt: number }): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const [c, model, index, rules] = await Promise.all([
    collect(sb),
    getFeatureModel("agent"),
    catalogIndex(sb),
    manualCoreText(/데이터 해석 기준|용어 정의/).catch(() => ""),
  ]);
  const usage: AskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estUsd: 0, estNote: "" };
  const toolLog: AgentToolLog[] = [];
  let rounds = 0, toolCalls = 0;
  const usageOut = () => ({ input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, rounds, tool_calls: toolCalls, elapsed_ms: Date.now() - startedAt });
  const fail = (m: string) => new AgentRunError(m, { model, usage: usageOut(), est_usd: usage.estUsd, tool_log: toolLog });

  const facts = {
    기준일: kstTodayLabel(), 목표일수: c.horizonDays, 부족기준일수: c.leadDays, 요청서기본마감: c.dueDate,
    경고: c.warnings, rows: c.rows, open_requests: c.openRequests, open_orders: c.openOrders,
  };
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: `${cfg.system}\n\n[조회 가능 관계(run_sql) — 이름과 한 줄 설명. 컬럼은 schema 도구로 확인]\n${index}\n\n[조회 불가(비공개 — 시도 금지)]\n${PRIVATE_NOTE}`, cache_control: { type: "ephemeral" } },
    { type: "text", text: rules ? `[회사 해석 기준 — 셰어포인트 '[비서]' 페이지 본문 그대로]\n${rules}` : "[회사 해석 기준] 셰어포인트 매뉴얼을 읽지 못했습니다. 회사 규칙을 확인하지 못했다고 '확인 필요'에 적습니다.", cache_control: { type: "ephemeral" } },
  ];
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: [{
      type: "text", cache_control: { type: "ephemeral" },
      text: `도매 생산 요청서 초안을 작성해 submit_report 로 제출하세요.\n\n[덧붙인 말]\n${p.instruction || "없음"}\n\n[지난 보고서 — 최신순]\n${casesBlock(p.cases)}\n\n[facts]\n${JSON.stringify(facts)}`,
    }],
  }];

  const ctx: ToolCtx = { sb, question: "도매 생산 요청서 초안 작성", sqlRuns: [], usage, auxModel: MODELS.opus, deadlineAt: p.deadlineAt };
  let strict = true, tools = agentTools(true), retried = false, nudged = 0;
  let submitted: Submit | null = null;

  while (!submitted) {
    const left = p.deadlineAt - Date.now();
    if (left < 20_000) throw fail("작성 시간이 부족해 보고서를 완성하지 못했습니다. [업무 요청]을 다시 누르세요.");
    const closing = rounds >= cfg.maxRounds || left < FINAL_RESERVE_MS + 30_000; // 조사 끝 — 제출만 받는다
    if (rounds >= cfg.maxRounds + 3) throw fail("에이전트가 결과를 제출하지 않았습니다. [업무 요청]을 다시 누르세요.");
    let res: Anthropic.Message;
    try {
      res = await anthropic.messages.create({
        model, max_tokens: MAX_TOKENS, system, messages, tools, tool_choice: { type: "auto" },
        ...effortParams(model, cfg.effort),
      }, { timeout: Math.min(180_000, left - 10_000), maxRetries: 0 });
    } catch (e) {
      if (strict && strictRejected(e)) { strict = false; tools = agentTools(false); continue; }
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
      wholesale_stock: f?.w.stock ?? null, daily_out: r2(f?.w.dailyOut ?? 0), days_left: f?.daysLeft ?? null,
      formula: f?.w.recommendNet ?? 0, open_req: f?.w.wholesaleReq ?? 0, retail_spare: f?.spare ?? null,
    });
  }
  const summary = s.summary.trim().slice(0, 300);
  const body_md = s.body_md.trim().slice(0, 12000);
  if (!summary && !body_md) throw fail(new AiResponseError("AI 가 빈 보고서를 돌려주었습니다.").message);

  return {
    summary, body_md, draft, tool_log: toolLog, model, usage: usageOut(), est_usd: usage.estUsd,
    facts: { today: c.today, horizon_days: c.horizonDays, lead_days: c.leadDays, due_date: c.dueDate, rows: c.rows.length, warnings },
  };
}
