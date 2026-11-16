// 도매 생산 요청서 에이전트 — 서버 전용.
//  역할(2026-11-11 대표 정의): 순수 도매 출고량(도매 대량 제외)과 도매 재고만으로, 생산이 필요한 품목만 주 1회 요청한다.
//   리드타임 7~10일(보통 화요일 작성 → 그다음 주 금요일 입고). 소매 재고는 고려하지 않는다.
//  사실은 코드가 모으고, 에이전트는 품목·수량·이유를 판단한다. 더 필요한 것은 읽기 전용 도구로 직접 조회.
//  결과는 submit_report 도구 한 번으로 받는다(강제 tool_choice 는 5.x 에서 400 — auto + 지시).
//  요청서가 되는 길은 둘: 담당자가 초안을 [결재]하면 그대로, [피드백 보내기]를 하면 이 실행기가 revise 로 다시 돌아 낸 수정본이 요청서가 된다(wholesale-apply.ts).
//  버전은 없다(2026-11-16 대표: "항상 최신 버전만 사용") — 지침(SYSTEM)·수집(collect)을 고치면 그것이 곧 지금 에이전트다. 옛 지침은 남기지 않는다(git 이력에 있다).
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInventoryRows } from "../production-inventory";
import { getLedgerVelocity } from "../production-velocity";
import { loadRequests } from "../wholesale-production-db";
import { kstTodayIso } from "../production-schedule";
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

const EFFORT = "medium" as const;
const MAX_ROUNDS = 8;   // 조사 차례 상한(그 뒤엔 제출만)
const CYCLE_DAYS = 7;   // 요청 주기(주 1회)

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
// 품목별 근거 숫자(보고서 표에 그대로 싣는다)
type Basis = { stock: number | null; dailyOut: number; daysLeft: number | null; formula: number; openReq: number; out7: number; out30: number; need: number };
type Collected = {
  today: string; dueDate: string; horizonDays: number; leadDays: number; nextArrival: string;
  modelFacts: Record<string, unknown>;  // 에이전트에게 주는 facts
  rows: Record<string, unknown>[]; bySku: Map<string, Basis>;
  products: Map<string, P>; bundleIds: Set<string>;
  openRequests: unknown[]; openOrders: unknown[]; warnings: string[];
};

// ── 사실 수집 — 순수 도매(2026-11-11 대표 정의) ──
//  재료는 둘뿐: 도매 칸 재고, 순수 도매 출고량(도매 대량·칸 이동·소매 제외 — getLedgerVelocity '도매'와 같은 행). 소매 재고는 읽지 않는다.
//  주기: 요청서는 주 1회(보통 화요일), 요청분은 그다음 주 금요일까지 입고(리드타임 7~10일).
//   → 이번 요청은 '다음 요청분이 입고될 때까지' 버텨야 한다: 버틸 일수 = 이번 입고까지 일수 + 요청 주기.
//  필요량 = 하루 출고 × 버틸 일수(올림), 수식 권장 = max(0, 필요량 − 도매 재고 − 이미 요청).
//  이미 요청 = 열린 도매 요청서(확정 필요·확정 모두)의 잔여 — 아직 확정 전인 요청서를 빼지 않으면 다음 주에 같은 양을 또 요청한다.
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 요청한 주의 다음 주 금요일까지의 일수(화요일 = 10일). 7일보다 짧게 나오는 주말 요청은 한 주 더 뒤로.
export function leadDaysFrom(ymd: string): number {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();   // 0=일 … 6=토
  const mondayBased = (dow + 6) % 7;                       // 0=월 … 6=일
  const lead = 7 - mondayBased + 4;                        // 다음 주 월요일까지 + 금요일(월+4)
  return lead < 7 ? lead + 7 : lead;
}
async function collect(sb: SupabaseClient): Promise<Collected> {
  const today = kstTodayIso();
  const warnings: string[] = [];
  const [wh, vel, prodRows, bundles, reqA, reqB, orders] = await Promise.all([
    getInventoryRows("도매"),
    getLedgerVelocity(undefined, "도매"),
    readAll<P>((a, b) => sb.from("products").select("id, sku, name, spec, unit, active").order("id", { ascending: true }).range(a, b)),
    sb.from("product_bundles").select("parent_id").limit(5000),
    loadRequests(sb, { status: "요청" }),
    loadRequests(sb, { status: "진행중" }),
    sb.from("orders").select("order_no, order_date, ship_date, is_bulk, companies(name), order_items(product_id, product_name, qty)")
      .eq("status", "발송대기").order("ship_date", { ascending: true, nullsFirst: false }).limit(200),
  ]);
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

  // 열린 도매 요청서(확정 필요·확정)의 품목별 잔여
  const open = [...reqA, ...reqB].filter((q) => q.purpose === "도매 납품");
  const openReqBySku = new Map<string, number>();
  for (const q of open) for (const it of q.items) {
    const k = String(it.sku || "").toUpperCase();
    const left = Math.max(0, it.requested_qty - it.received_qty);
    if (k && left > 0) openReqBySku.set(k, r2((openReqBySku.get(k) || 0) + left));
  }
  const openRequests = open.map((q) => ({
    요청번호: q.req_no, 상태: q.status === "진행중" ? "확정" : "확정 필요", 요청일: q.request_date, 입고예정: q.due_date, 제목: q.title, 메모: q.memo,
    품목: q.items.map((it) => ({ sku: it.sku, 품목: it.name, 요청: it.requested_qty, 입고: it.received_qty, 잔여: r2(Math.max(0, it.requested_qty - it.received_qty)) })),
  }));

  const lead = leadDaysFrom(today);
  const cover = lead + CYCLE_DAYS;
  const dueDate = addDays(today, lead);
  const nextArrival = addDays(today, cover);
  const wt = vel.windowTotals;
  if (!wt) warnings.push("창별 도매 출고 합계를 읽지 못했습니다.");

  const bySku: Collected["bySku"] = new Map();
  const rows: Record<string, unknown>[] = [];
  for (const w of wh.rows) {
    const openReq = openReqBySku.get(w.sku) || 0;
    const need = Math.ceil(w.dailyOut * cover);
    const formula = Math.max(0, r2(need - (w.stock ?? 0) - openReq));
    const daysLeft = w.stock != null && w.dailyOut > 0 ? Math.floor(Math.max(0, w.stock) / w.dailyOut) : null;
    const out7 = r2(wt?.d7[w.sku] || 0), out30 = r2(wt?.short[w.sku] || 0), out90 = r2(wt?.long[w.sku] || 0);
    bySku.set(w.sku, { stock: w.stock, dailyOut: w.dailyOut, daysLeft, formula, openReq, out7, out30, need });
    // 도매 출고가 한 번도 없고 요청도 없는 품목은 판단 대상이 아니다
    if (!(w.dailyOut > 0 || openReq > 0 || out90 > 0)) continue;
    rows.push({ sku: w.sku, 품목: w.name, 도매재고: w.stock, 최근7일출고: out7, 최근30일출고: out30, 최근90일출고: out90, 하루출고: r2(w.dailyOut), 버티는일수: daysLeft, 이미요청: openReq, 필요량: need, 수식권장: formula });
  }
  rows.sort((a, b) => (b.수식권장 as number) - (a.수식권장 as number) || String(a.sku).localeCompare(String(b.sku)));

  if (orders.error) warnings.push("발송 대기 B2B 발주를 읽지 못했습니다.");
  type O = { order_no: string; order_date: string; ship_date: string | null; is_bulk: boolean | null; companies: { name?: string } | { name?: string }[] | null; order_items: { product_id: string | null; product_name: string; qty: number }[] };
  const openOrders = ((orders.data ?? []) as unknown as O[]).filter((o) => !o.is_bulk).map((o) => ({
    발주번호: o.order_no, 발주일: o.order_date, 발송예정일: o.ship_date,
    거래처: (Array.isArray(o.companies) ? o.companies[0]?.name : o.companies?.name) ?? null,
    품목: (o.order_items ?? []).map((it) => ({ sku: it.product_id ? idToSku.get(it.product_id) ?? null : null, 품목: it.product_name, 수량: Number(it.qty) || 0 })),
  }));

  return {
    today, dueDate, horizonDays: cover, leadDays: lead, nextArrival,
    modelFacts: {
      기준일: kstTodayLabel(), 요청주기일수: CYCLE_DAYS, 이번요청입고예정일: dueDate, 입고까지일수: lead, 다음요청분입고예정일: nextArrival, 버틸일수: cover,
      출고평균일수: wt ? { 단기: wt.shortDays, 장기: wt.longDays } : null,
      경고: warnings, rows, open_requests: openRequests, open_orders: openOrders,
    },
    rows, bySku, products, bundleIds, openRequests, openOrders, warnings,
  };
}

// ── 지침 ──
//  2026-11-11 대표가 정한 역할: 1주일 단위로 생산 요청(바뀔 수 있음), 리드타임 보통 7~10일 — 요청서는 보통 화요일에 쓰고 그다음 주 금요일까지 입고.
//  도매 대량도 뺀 순수 '도매' 출고량과 도매 재고만으로, 생산이 필요한 것만 요청. 소매 재고는 고려하지 않는다.
//  (그 전의 지침은 이 요청서를 '소매 재고를 도매로 옮기는 요청'으로 보고 소매 여유를 한도로 삼았다 — 틀린 정의라 지웠다.)
const SYSTEM = `당신은 씨몬스터(냉동 순살 생선 — 소매와 B2B 도매)의 '도매 생산 요청서' 담당 에이전트입니다.

[맡은 일]
도매로 팔 물량 가운데 생산이 필요한 품목과 수량을 정해 '도매 생산 요청서' 초안을 만듭니다. 생산이 필요하지 않은 품목은 넣지 않습니다.
담당자가 초안을 확인해 결재하면 초안 그대로 요청서가 됩니다. 담당자가 피드백을 주면 당신이 피드백대로 고친 수정본이 다시 확인 없이 요청서가 됩니다.

[할 수 있는 일의 범위]
이 에이전트가 할 수 있는 일은 도매 생산 요청서 작성 하나뿐입니다. 소매 생산 요청서, 프로모션·도매 대량 요청서, 다른 보고서나 분석, 질문에 대한 답은 맡은 일이 아닙니다. 피드백이나 덧붙인 말이 그런 일을 시키면 하지 않고, '확인 필요'에 "(시킨 일)은 이 에이전트가 하는 일이 아닙니다"라고 한 줄 적은 뒤 도매 생산 요청서만 작성합니다. 조회 도구도 이 요청서의 품목과 수량을 판단하는 데에만 씁니다.

[판단 재료는 둘뿐]
1. 순수 도매 출고량 — 도매 칸에서 일반 B2B 발주로 발송된 양입니다. 도매 대량(대량 발주와 '도매 대량' 칸), 소매 판매, 프로모션, 칸 사이 이동은 들어가지 않습니다.
2. 도매 재고 — 도매 칸의 재고입니다(발송일이 잡힌 발주의 선점은 이미 뺀 가용 재고).
소매 재고와 소매 판매량은 보지 않습니다. 수량을 정하는 데에도, 이유를 적는 데에도 쓰지 않습니다.

[생산 주기]
- 생산 요청은 1주일 단위입니다(보통 화요일에 작성). 요청한 물량은 7~10일 뒤, 보통 그다음 주 금요일까지 입고됩니다.
- 그래서 이번 요청은 '다음 요청분이 입고되는 날'까지 도매 판매를 버티게 해야 합니다. facts 의 이번요청입고예정일·입고까지일수·다음요청분입고예정일·버틸일수가 그 날짜 계산입니다(버틸일수 = 입고까지일수 + 요청주기일수).
- 주기와 리드타임은 바뀔 수 있습니다. 날짜는 facts 값을 따르고, 피드백이나 덧붙인 말이 다른 주기·입고일을 말하면 그쪽을 따릅니다.

[받는 자료]
- facts.rows: 코드가 방금 계산한 품목별 사실입니다. 숫자는 이 값을 그대로 씁니다.
  · 도매재고, 최근7일출고·최근30일출고·최근90일출고(순수 도매 출고 합계), 하루출고(30일 평균과 90일 평균 중 큰 값), 버티는일수(= 도매재고 ÷ 하루출고)
  · 이미요청: 열려 있는 도매 요청서의 잔여 — 곧 들어올 양입니다(아직 확정 전인 요청서 포함).
  · 필요량 = 하루출고 × 버틸일수, 수식권장 = max(0, 필요량 − 도매재고 − 이미요청)
- facts.open_requests: 열려 있는 도매 요청서. facts.open_orders: 발송 대기 중인 일반 도매 발주(대량 발주는 빠져 있습니다).
- 회사 해석 기준: 생산 요청에 관한 회사 규칙이 있으면 그대로 따릅니다.
- 지난 보고서: 당신이 전에 낸 첫 초안, 요청서로 확정된 수량, 담당자의 피드백입니다. 담당자가 고친 방향을 같은 상황에 미리 적용합니다. 단 소매 재고를 근거로 삼았던 옛 판단은 따르지 않습니다.
- 담당자 피드백(있을 때만): 당신이 낸 초안과 그에 대한 담당자의 피드백입니다. 피드백이 말한 것은 그대로 반영하고, 말하지 않은 품목과 수량은 초안 그대로 둡니다. 피드백이 '요청하지 않는다'는 뜻이면 items 를 비워 제출합니다. 피드백의 뜻이 여러 가지로 읽히면 수량이 적은 쪽으로 정하고 '확인 필요'에 어떻게 읽었는지 적습니다.
- 덧붙인 말: 이번 요청에 사람이 준 정보나 지시입니다. 도매 생산 요청서의 품목과 수량에 관한 것이면 다른 기준보다 우선합니다.

[판단 기준]
1. 생산이 필요한 품목 = 도매재고와 이미요청을 합쳐도 다음요청분입고예정일까지 버티지 못하는 품목입니다. 출발점은 수식권장이고, 수식권장이 0인 품목은 넣지 않습니다(피드백·덧붙인 말·회사 규칙이 시킬 때만 예외).
2. 출고 추이를 봅니다. 최근7일출고가 30일·90일 평균보다 뚜렷이 많거나 적으면 어느 쪽이 앞으로 2~3주를 대표하는지 판단해 수량을 올리거나 내리고, 그 판단을 이유에 적습니다. 평균을 끌어올린 것이 한 번의 큰 발주로 보이면 조회로 확인하고, 일회성이면 그 발주를 빼고 봅니다.
3. 이미요청이 있는 품목은 그만큼 이미 요청된 것입니다. 같은 양을 다시 요청하지 않습니다.
4. 도매재고는 발송일이 잡힌 발주의 선점을 이미 뺀 값입니다. open_orders 의 수량을 다시 빼지 않습니다.
5. 버티는일수가 입고까지일수보다 짧은 품목은 이번 요청분이 들어오기 전에 재고가 바닥납니다. 급한 품목(urgent)으로 표시합니다.
6. 수량은 품목의 판매 단위 개수(정수)입니다. 근거 없이 올림·내림하지 않습니다.
7. 확인하지 못한 것은 추측으로 채우지 않고 '확인 필요'에 적습니다.

[도구]
- schema, run_sql: 읽기 전용 조회입니다. facts 로 판단이 서면 쓰지 않습니다. 일회성 큰 발주인지, 특정 거래처의 발주 주기가 어떤지처럼 판단이 갈리는 것만 확인합니다(보통 0~4회).
  원장(inventory_txns)을 직접 볼 때는 순수 도매만 남깁니다: channel = '도매', type = '출고', status = '완료', txn_date 는 오늘까지, 칸 이동 행(source 가 'move'·'promo_close', 또는 주문번호 없는 partner '채널이동') 제외, 대량 발주(orders.is_bulk)의 발송 행 제외. 이 조건을 못 맞추겠으면 조회 결과를 쓰지 말고 facts 값을 씁니다.
- search_text, read_report: 요청서 메모·종합 리포트 본문이 필요할 때.
- submit_report: 결과 제출. 마지막에 정확히 한 번 호출합니다. 글로만 답하고 끝내지 않습니다.

[제출 형식]
- summary: 한 문장. 품목 수와 가장 중요한 판단.
- items: 생산을 요청할 품목. sku 는 facts 의 sku 그대로, qty 는 수량, reason 은 한두 문장(도매 출고량과 도매 재고 숫자 포함), urgent 는 급함 여부.
- body_md: 아래 틀. '##' 제목, '-' 목록, '**굵게**' 만 씁니다(표·코드 블록 없음). 날짜는 '이번 주' 같은 말 대신 실제 날짜로 적습니다.

## 판단 근거
- (입고 예정일과 버틸 기간, 수량을 정한 원칙)
## 요청하지 않은 품목
- (수식권장이 있었지만 넣지 않았거나 줄인 품목과 이유. 없으면 이 제목을 뺍니다)
## 확인 필요
- (사람이 확인할 것. 없으면 이 제목을 뺍니다)`;

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
    const applied = c.applied == null ? "아직 결재 전"
      : c.applied.map((a) => `${a.sku} ${a.qty}${a.draft_qty == null ? "(초안에 없던 품목)" : a.draft_qty !== a.qty ? `(초안 ${a.draft_qty})` : ""}`).join(", ") || "요청 없이 닫음";
    return `- ${c.date} 요약: ${c.summary || "-"}\n  첫 초안: ${draft}\n  요청서로 확정: ${applied}\n  담당자 피드백: ${c.feedback || "없음(초안 그대로 결재)"}`;
  }).join("\n");
}

type Submit = { summary: string; items: { sku: string; qty: number; reason: string; urgent: boolean }[]; body_md: string };

export type ReviseInput = { summary: string | null; draft: { sku: string; name: string; qty: number; reason: string }[]; feedback: string };
export type RunInput = { instruction: string | null; cases: PriorCase[]; deadlineAt: number; revise?: ReviseInput };

export async function runWholesaleRequest(sb: SupabaseClient, p: RunInput): Promise<AgentRunResult> {
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

  const facts = c.modelFacts;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: `${SYSTEM}\n\n[조회 가능 관계(run_sql) — 이름과 한 줄 설명. 컬럼은 schema 도구로 확인]\n${index}\n\n[조회 불가(비공개 — 시도 금지)]\n${PRIVATE_NOTE}`, cache_control: { type: "ephemeral" } },
    { type: "text", text: rules ? `[회사 해석 기준 — 셰어포인트 '[비서]' 페이지 본문 그대로]\n${rules}` : "[회사 해석 기준] 셰어포인트 매뉴얼을 읽지 못했습니다. 회사 규칙을 확인하지 못했다고 '확인 필요'에 적습니다.", cache_control: { type: "ephemeral" } },
  ];
  // 피드백 반영이면 첫 초안과 피드백을 함께 준다 — 제출한 수정본은 그대로 요청서가 된다
  const task = p.revise
    ? "담당자 피드백을 반영한 도매 생산 요청서 수정본을 submit_report 로 제출하세요. 제출한 수정본은 그대로 요청서가 됩니다."
    : "도매 생산 요청서 초안을 작성해 submit_report 로 제출하세요.";
  const revised = p.revise
    ? `[담당자 피드백]\n${p.revise.feedback}\n\n[당신이 낸 초안]\n요약: ${p.revise.summary || "-"}\n${p.revise.draft.map((d) => `- ${d.sku} ${d.name} ${d.qty} — ${d.reason}`).join("\n") || "- 품목 없음"}\n\n`
    : "";
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: [{
      type: "text", cache_control: { type: "ephemeral" },
      text: `${task}\n\n${revised}[덧붙인 말]\n${p.instruction || "없음"}\n\n[지난 보고서 — 최신순]\n${casesBlock(p.cases)}\n\n[facts — 방금 계산한 값]\n${JSON.stringify(facts)}`,
    }],
  }];

  const ctx: ToolCtx = { sb, question: "도매 생산 요청서 초안 작성", sqlRuns: [], usage, auxModel: MODELS.opus, deadlineAt: p.deadlineAt };
  let strict = true, tools = agentTools(true), retried = false, nudged = 0;
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
    facts: { today: c.today, horizon_days: c.horizonDays, lead_days: c.leadDays, due_date: c.dueDate, rows: c.rows.length, warnings, next_arrival: c.nextArrival },
  };
}
