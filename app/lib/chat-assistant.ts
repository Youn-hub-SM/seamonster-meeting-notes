// AI 비서 대화 엔진(2026-10-19 대표 결정 — "클로드 웹처럼 대화형 AI", docs/assistant-plan.md §5-2)
//  스레드(report_threads) 하나에 메시지 전부(모델 응답 블록·도구 호출·도구 결과)를 그대로 저장하고(report_messages),
//  매 턴 그 전체를 이어 붙여 모델을 부른다. 답 틀(JSON) 없음 — 모델이 글로 말하고, 필요하면 중간에 도구를 쓰며,
//  run_sql 결과는 표 카드(report_tables)로 그 자리에 끼운다. 글은 스트리밍으로 흘려보낸다(NDJSON 이벤트).
//  긴 스레드는 앞부분을 보조 모델로 요약해 접는다(thread.summary + compact_seq).
//  안전·비용·도구는 assistant.ts 공용(쓰기 도구 없음, run_report 읽기 전용, 마스킹, 월 상한·끄기).
import Anthropic from "@anthropic-ai/sdk";
import { generateNotice, NOTICE_REFINES, type NoticeRefine } from "./notice";
import { NOTICE_CHANNELS } from "./notice-types";
import { generateCsAdvice } from "./cs";
import { supabaseAdmin } from "./supabase";
import { getFeatureModel, effortParams, AiResponseError, readText } from "./ai-model";
import { MODELS } from "./config";
import { isAdminName } from "./b2b-auth";
import { LOOKER_RELATIONS } from "./report-schema";
import { gaCatalogPromptBlock } from "./ga-catalog";
import { docsPromptBlock, manualKnowledgeBlock } from "./ms365-docs";
import { getAssistantPrompt } from "./assistant-prompt";
import { computeSpecItem, loadMarginRef, type MarginSpec, type MarginRefData, type MarginResultItem } from "./margin-calc";
import { liveToolDefs, liveToolLabel, isLiveTool, runLiveTool, newLiveState, ADS_TIMEOUT_MS } from "./chat-live-tools";
import {
  anthropic, toolDefs, runTool, toolLabel, addUsage, addAssistantUsage, getAssistantSettings, getAssistantMonthUsage,
  AssistantOffError, catalogIndex, PRIVATE_NOTE, kstTodayLabel, retryable, strictRejected, withTimeout,
  TOOL_TIMEOUT_MS, SEARCH_TIMEOUT_MS, type ToolCtx, type AskUsage, type AskLooker,
} from "./assistant";

// ── 화면 계약 ──
export type ChatTable = { id: string; toolUseId: string; title: string; sql: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; looker?: AskLooker };
export type ChatItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; toolUseId: string; name: string; label: string; ok: boolean | null; ms?: number; table?: ChatTable };
export type ChatThread = { id: string; title: string; createdBy: string; createdAt: string; updatedAt: string; estUsd: number };
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; toolUseId: string; name: string; label: string; status: "start" | "ok" | "fail"; ms?: number }
  | { type: "table"; table: ChatTable }
  | { type: "done"; model: string; usage: AskUsage; downgraded: boolean; timedOut: boolean; elapsedMs: number; title: string; seq: number | null; dataDate: string | null }
  | { type: "error"; error: string };

type ThreadRow = { id: string; title: string; created_by: string; model: string | null; summary: string | null; compact_seq: number; archived: boolean; est_usd: number | string; created_at: string; updated_at: string };
type MessageRow = { id: string; seq: number; role: "user" | "assistant"; content: unknown; usage: unknown; created_at: string };
type TableRow = { id: string; tool_use_id: string; title: string; sql: string; columns: string[]; rows: Record<string, unknown>[]; row_count: number; truncated: boolean; looker: AskLooker | null };

// ── 한계값 ──
export const CHAT_DEADLINE_MS = 270_000;  // 라우트 maxDuration 300
const MAX_ROUNDS = 12;                    // 한 턴 안의 도구 차례
const FINAL_RESERVE_MS = 60_000;          // 이 시간이 남으면 도구 없이 마무리하게 한다
const MAX_TOKENS = 24000;                 // 2026-10-20 8000→24000 — effort high 의 생각 토큰도 이 한도에 든다(스트리밍이라 시간 제한과 무관)
const COMPACT_AT_CHARS = 70_000;          // 모델에 넣는 메시지 글자 수가 넘으면 앞부분을 접는다
const KEEP_EXCHANGES = 3;                 // 접을 때 남겨 둘 최근 사용자 메시지 수
const SUMMARY_MAX = 4000;
const THREAD_LIST_LIMIT = 40;

export const PENDING_139 = "DB 준비 전입니다 — supabase/migrations/139_report_chat.sql 을 적용하세요.";
export function isPending139(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? "");
  return /report_(threads|messages|tables)/.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

// ── 시스템 프롬프트(고정 — 캐시) ──
// 시스템 프롬프트 — 조회 가능 목록(살아 있는 스키마)은 턴마다 넣는다(10분 캐시, 바뀌면 캐시 prefix 만 다시 쓴다)
// 시스템 프롬프트 = 지침 칸(관리자 편집) + 매뉴얼 핵심 페이지·목차(셰어포인트, 10분 캐시) + 조회 가능 관계(코드). 전부 첫 블록(캐시)에.
function systemChat(instructions: string, knowledge: string, index: string): string {
  return `${instructions}

${knowledge}

[조회 가능 관계(run_sql) — 이름과 한 줄 설명. 컬럼은 schema 도구로 확인]
${index}

[루커 노출 뷰(looker_ro)]
${LOOKER_RELATIONS.join(", ")}

[조회 불가(비공개 — 시도 금지)]
${PRIVATE_NOTE}`;
}

// ── 도구 — 공용 4개(ask_user 제외: 되묻기는 글로) + 용어 제안 ──
function chatTools(strict: boolean): Anthropic.Tool[] {
  const s = strict ? { strict: true } : {};
  return [
    ...toolDefs(strict).filter((t) => t.name !== "ask_user"),
    ...liveToolDefs(strict),
    {
      name: "margin_calc", ...s,
      description: "이익률 계산기와 같은 고정 산식으로 가상 판매 시나리오의 순이익·이익률을 계산합니다(원가표·채널 수수료·택배비·아이스박스·보냉비·부가세). 가격 설계 질문('15% 할인에 1+1로 팔면', '쿠팡으로 옮기면')에 씁니다. 실적(이미 팔린 것)의 이익은 run_sql 로 구합니다. 한 번에 여러 시나리오(items)를 넣어 비교할 수 있습니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["items"],
        properties: {
          items: {
            type: "array", minItems: 1, maxItems: 8,
            items: {
              type: "object", additionalProperties: false,
              required: ["sku", "productName", "channel", "feeRatePct", "priceBasis", "customTotal", "discountPct", "qty", "paidUnits", "boxes", "extraCosts"],
              properties: {
                sku: { type: ["string", "null"], description: "상품 SKU(알면). 없으면 null → productName 으로 찾음" },
                productName: { type: "string", description: "상품명(원가표 이름, 예: '대구순살 1kg')" },
                channel: { type: "string", description: "채널명(스마트스토어·쿠팡·카페24·톡스토어·도매 등 채널표 이름)" },
                feeRatePct: { type: ["number", "null"], description: "채널표에 없는 채널일 때 가정 수수료율(%). 보통 null(채널표 조회)" },
                priceBasis: { type: "string", enum: ["retail", "wholesale", "custom"], description: "retail 소비자가 / wholesale 도매가 / custom 총 결제가 직접 지정" },
                customTotal: { type: ["number", "null"], description: "priceBasis=custom 일 때 고객 총 결제가(원). 아니면 null" },
                discountPct: { type: "number", description: "할인율 %(0~100). 없으면 0" },
                qty: { type: "integer", description: "고객에게 나가는 수량(원가·부피 반영). 1+1 이면 2" },
                paidUnits: { type: "integer", description: "결제 수량(매출 = 기준가×할인×이 수량). 1+1 이면 1" },
                boxes: { type: "integer", description: "박스 수(배송원가 × 박스). 보통 1" },
                extraCosts: { type: ["array", "null"], items: { type: "object", additionalProperties: false, required: ["label", "amount"], properties: { label: { type: "string" }, amount: { type: "number" } } }, description: "질문에 명시된 기타 비용(원). 없으면 null" },
              },
            },
          },
        },
      },
    },
    {
      name: "write_notice", ...s,
      description: "공지 작성기와 같은 규칙으로 고객·거래처 공지문 초안을 씁니다(유형 판단·항목 추출·채널 글자 수 반영). 쓰기 없음 — 초안만 돌려줍니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["channel", "text", "refine", "previous"],
        properties: {
          channel: { type: "string", enum: [...NOTICE_CHANNELS], description: "보낼 채널" },
          text: { type: "string", description: "공지할 내용 — 사용자가 말한 사실(무엇이·언제·누구에게·보상 등)을 빠짐없이 그대로" },
          refine: { type: ["string", "null"], enum: [...NOTICE_REFINES, null], description: "다듬기: shorter 더 짧게 / politer 더 정중하게 / compensation 보상·조치 더 분명하게. 처음 쓸 땐 null" },
          previous: { type: ["string", "null"], description: "다듬을 때 직전 초안 본문. 처음 쓸 땐 null" },
        },
      },
    },
    {
      name: "cs_coach", ...s,
      description: "CS 코치와 같은 매뉴얼·지침으로 고객 문의 응대를 코칭합니다(상황 진단·응대 방향·추천 답변·주의·적용 정책). 쓰기 없음.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["query"],
        properties: {
          query: { type: "string", description: "고객 문의 원문 또는 상황 설명(채널·주문 상황 등 사용자가 준 정보 그대로)" },
        },
      },
    },
  ];
}

// 매출 원장 최신일 — 답 머리에 '데이터 최신일'을 자동으로 보여 주고(개선안 5), 모델에도 넣는다
async function salesDataDate(): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin().rpc("run_report", { q: "select max(order_date)::text as d from sales_orders where order_date <= (now() at time zone 'Asia/Seoul')::date" });
    if (error) return null;
    const d = Array.isArray(data) ? (data[0] as { d?: string } | undefined)?.d : null;
    return d ? String(d) : null;
  } catch { return null; }
}

// ── 스레드 ──
const sb = () => supabaseAdmin();
const canSee = (t: ThreadRow, user: string) => t.created_by === user || isAdminName(user);
const toThread = (t: ThreadRow): ChatThread => ({ id: t.id, title: t.title || "(제목 없음)", createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at, estUsd: Number(t.est_usd) || 0 });

export async function listThreads(user: string, all = false): Promise<ChatThread[]> {
  let q = sb().from("report_threads").select("*").eq("archived", false).order("updated_at", { ascending: false }).limit(THREAD_LIST_LIMIT);
  if (!(all && isAdminName(user))) q = q.eq("created_by", user);
  const { data, error } = await q;
  if (error) throw error;
  return ((data || []) as ThreadRow[]).map(toThread);
}

export async function createThread(user: string): Promise<ChatThread> {
  const { data, error } = await sb().from("report_threads").insert({ created_by: user, title: "" }).select("*").single();
  if (error) throw error;
  return toThread(data as ThreadRow);
}

async function getThreadRow(id: string, user: string): Promise<ThreadRow | null> {
  const { data, error } = await sb().from("report_threads").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  const t = data as ThreadRow | null;
  return t && !t.archived && canSee(t, user) ? t : null;
}

export async function archiveThread(id: string, user: string): Promise<boolean> {
  const t = await getThreadRow(id, user);
  if (!t) return false;
  const { error } = await sb().from("report_threads").update({ archived: true }).eq("id", id);
  if (error) throw error;
  return true;
}

async function loadMessages(threadId: string, minSeq = 0): Promise<MessageRow[]> {
  const out: MessageRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb().from("report_messages").select("id, seq, role, content, usage, created_at")
      .eq("thread_id", threadId).gt("seq", minSeq).order("seq").range(from, from + 999);
    if (error) throw error;
    const rows = (data || []) as MessageRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function loadTables(threadId: string): Promise<Map<string, ChatTable>> {
  const { data, error } = await sb().from("report_tables").select("id, tool_use_id, title, sql, columns, rows, row_count, truncated, looker").eq("thread_id", threadId);
  if (error) throw error;
  const m = new Map<string, ChatTable>();
  for (const r of (data || []) as TableRow[]) m.set(r.tool_use_id, { id: r.id, toolUseId: r.tool_use_id, title: r.title, sql: r.sql, columns: r.columns || [], rows: r.rows || [], rowCount: r.row_count, truncated: r.truncated, looker: r.looker || undefined });
  return m;
}

type Block = Anthropic.ContentBlockParam | Anthropic.ContentBlock;
const blocksOf = (content: unknown): Block[] => typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];

// 저장된 메시지 → 화면 항목(사용자 글 / 비서 글 / 도구 칩+표)
export async function loadThreadItems(id: string, user: string): Promise<{ thread: ChatThread; items: ChatItem[] } | null> {
  const t = await getThreadRow(id, user);
  if (!t) return null;
  const [msgs, tables] = await Promise.all([loadMessages(id), loadTables(id)]);
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  for (const m of msgs) {
    for (const b of blocksOf(m.content)) {
      if (b.type === "text") {
        const text = String((b as { text?: string }).text || "").trim();
        if (text) items.push({ role: m.role, text });
      } else if (b.type === "tool_use") {
        const u = b as Anthropic.ToolUseBlock;
        const input = (u.input || {}) as Record<string, unknown>;
        toolIdx.set(u.id, items.length);
        items.push({ role: "tool", toolUseId: u.id, name: u.name, label: isLiveTool(u.name) ? liveToolLabel(u.name, input) : toolLabel(u.name, input), ok: null, table: tables.get(u.id) });
        for (let n = 1; tables.has(`${u.id}#${n}`); n++) { const t2 = tables.get(`${u.id}#${n}`)!; items.push({ role: "tool", toolUseId: t2.toolUseId, name: "", label: t2.title, ok: true, table: t2 }); } // 한 도구의 두 번째 표부터(칩 없이 표만)
      } else if (b.type === "tool_result") {
        const r = b as Anthropic.ToolResultBlockParam;
        const i = toolIdx.get(r.tool_use_id);
        if (i != null) { const it = items[i]; if (it.role === "tool") it.ok = !r.is_error; }
      }
    }
  }
  return { thread: toThread(t), items };
}

// 모델에 넣을 메시지 — 접힌 앞부분은 요약으로, 지난 턴의 thinking 블록은 뺀다(도구 루프 중이 아닌 과거 턴은 생략 가능)
function toModelMessages(t: ThreadRow, msgs: MessageRow[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  if (t.summary) {
    out.push({ role: "user", content: `[이전 대화 요약 — 이 스레드의 앞부분]\n${t.summary}` });
    out.push({ role: "assistant", content: "네, 앞의 대화를 기억하고 이어서 돕겠습니다." });
  }
  for (const m of msgs) {
    if (m.role === "assistant") {
      const blocks = blocksOf(m.content).filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") as Anthropic.ContentBlockParam[];
      out.push({ role: "assistant", content: blocks.length ? blocks : "(생략)" });
    } else {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : (blocksOf(m.content) as Anthropic.ContentBlockParam[]) });
    }
  }
  return out;
}
const charsOf = (ms: Anthropic.MessageParam[]) => ms.reduce((s, m) => s + JSON.stringify(m.content).length, 0);

async function nextSeq(threadId: string): Promise<number> {
  const { data, error } = await sb().from("report_messages").select("seq").eq("thread_id", threadId).order("seq", { ascending: false }).limit(1);
  if (error) throw error;
  return (Number((data?.[0] as { seq?: number } | undefined)?.seq) || 0) + 1;
}
async function saveMessage(threadId: string, seq: number, role: "user" | "assistant", content: unknown, usage?: unknown): Promise<void> {
  const { error } = await sb().from("report_messages").insert({ thread_id: threadId, seq, role, content, usage: usage ?? null });
  if (error) throw error;
}

// ── 한 턴 ──
// 화면에서 고를 수 있는 모델(2026-10-19 대표: "쉬운 계산도 Fable 은 좀 늦다") — 그 턴에만 적용. 월 상한을 넘으면 선택과 무관하게 Opus 낮음.
export const CHAT_MODEL_KEYS = ["fable", "opus", "sonnet"] as const;
export type ChatModelKey = (typeof CHAT_MODEL_KEYS)[number];

// signal: 화면의 [중지](2026-10-21 클로드 코드식 화면) — 끊기면 다음 차례를 시작하지 않고, 흐르던 응답도 멈춘다.
//  도구 실행 중이면 그 결과까지 저장한 뒤 멈춘다(tool_use 뒤에 tool_result 가 빠지면 다음 턴이 API 오류가 나므로).
export async function runChatTurn(p: { threadId: string; text: string; user: string; modelKey?: ChatModelKey | null; signal?: AbortSignal; send: (e: ChatEvent) => void }): Promise<void> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + CHAT_DEADLINE_MS;
  const text = (p.text || "").trim();
  if (!text) throw new AiResponseError("메시지를 입력하세요.");
  if (!process.env.ANTHROPIC_API_KEY) throw new AiResponseError("ANTHROPIC_API_KEY 가 설정되어 있지 않습니다.");

  const [settings, month, featureModel, thread, dataDate, schemaIndex, gaBlock, docsBlock, instructions, knowledge] = await Promise.all([getAssistantSettings(), getAssistantMonthUsage(), getFeatureModel("report"), getThreadRow(p.threadId, p.user), salesDataDate(), catalogIndex(supabaseAdmin()), gaCatalogPromptBlock(), docsPromptBlock(), getAssistantPrompt(), manualKnowledgeBlock().catch((e) => `[매뉴얼 핵심 페이지] 읽기 실패: ${e instanceof Error ? e.message : String(e)}`)]);
  if (settings.off) throw new AssistantOffError("AI 비서가 꺼져 있습니다. 관리자 › 설정 › AI 에서 켜세요.");
  if (!thread) throw new AiResponseError("대화를 찾을 수 없습니다. 새 대화를 시작하세요.");
  const downgraded = month.usd >= settings.capUsd;
  const picked = p.modelKey && (CHAT_MODEL_KEYS as readonly string[]).includes(p.modelKey) ? MODELS[p.modelKey] : null;
  const model = downgraded ? MODELS.opus : (picked || featureModel);
  const auxModel = MODELS.opus;
  // 생각 강도(2026-10-20 대표 "품질을 과감히"): Fable(기본) = high, 화면에서 고른 Opus·Sonnet = medium(빠른 답용), 상한 초과 = low
  const effort = downgraded ? "low" : model === MODELS.fable ? "high" : "medium";
  const live = newLiveState(); // 광고 조회 결과는 이 턴 안에서 재사용

  const usage: AskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estUsd: 0, estNote: "" };
  const ctx: ToolCtx = { sb: sb(), question: text, sqlRuns: [], usage, auxModel, deadlineAt };

  const prior = await loadMessages(p.threadId, thread.compact_seq);
  const messages = toModelMessages(thread, prior);
  let seq = await nextSeq(p.threadId);
  await saveMessage(p.threadId, seq++, "user", text);
  messages.push({ role: "user", content: text });
  const title = thread.title || text.replace(/\s+/g, " ").slice(0, 60);
  if (!thread.title) await sb().from("report_threads").update({ title }).eq("id", p.threadId);

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemChat(instructions, knowledge, schemaIndex), cache_control: { type: "ephemeral" } },
    { type: "text", text: [
      `[오늘] 기준일(Asia/Seoul): ${kstTodayLabel()} — '오늘·어제·이번 주·이번 달·올해·최근 N일' 등 상대 기간은 반드시 이 날짜 기준. 학습 시점의 연도를 가정하지 않습니다.`,
      dataDate ? `[데이터 최신일] 매출 원장(sales_orders)은 ${dataDate}까지 들어 있습니다. 그 뒤 날짜는 아직 없으니 답에 "데이터는 ${dataDate}까지"라고 적습니다.` : "",
      `[사용자] ${p.user}`,
      gaBlock,
      docsBlock,
    ].filter(Boolean).join("\n") },
  ];
  let strict = true;
  let tools = chatTools(strict);
  let retried = false, timedOut = false, wrapUp = false;
  let toolCount = 0;
  let lastAssistantSeq: number | null = null; // 피드백(맞아요/틀려요)이 가리킬 비서 메시지
  let marginRef: MarginRefData | null = null; // 이익률 계산기 기준 데이터(원가표·채널) — 턴 안에서 한 번만 읽는다

  try {
    for (let round = 0; round < MAX_ROUNDS + 1; round++) {
      if (p.signal?.aborted) break; // 사용자가 [중지]
      const left = deadlineAt - Date.now();
      if (left < 20_000) { timedOut = true; break; }
      const finalTurn = wrapUp || round >= MAX_ROUNDS || left < FINAL_RESERVE_MS + SEARCH_TIMEOUT_MS;
      if (finalTurn && !wrapUp && round > 0) {
        timedOut = round < MAX_ROUNDS;
        messages.push({ role: "user", content: `[안내] ${round >= MAX_ROUNDS ? "이 턴의 도구 차례 한도에 닿았습니다." : "시간이 거의 끝났습니다."} 지금까지 모은 것으로 답을 마무리하고, 못 본 것은 한 줄로 적어 주세요.` });
        wrapUp = true;
      }
      const timeout = Math.max(30_000, Math.min(finalTurn ? 150_000 : 90_000, left - 10_000));

      let res: Anthropic.Message;
      try {
        const stream = anthropic.messages.stream({
          model, max_tokens: MAX_TOKENS, system, messages,
          tools, tool_choice: finalTurn ? { type: "none" } : { type: "auto" },
          ...effortParams(model, effort),
        }, { timeout, maxRetries: 0, signal: p.signal });
        stream.on("text", (delta) => { if (delta) p.send({ type: "text", delta }); });
        res = await stream.finalMessage();
      } catch (e) {
        if (p.signal?.aborted) break; // [중지] — 흐르던 응답은 저장하지 않고 끝낸다(앞선 기록은 온전)
        if (strict && strictRejected(e)) { strict = false; tools = chatTools(false); round--; continue; }
        if (!retried && retryable(e) && deadlineAt - Date.now() > FINAL_RESERVE_MS) { retried = true; await new Promise((r) => setTimeout(r, 3000)); round--; continue; }
        throw e;
      }
      addUsage(usage, model, res.usage);
      if (res.stop_reason === "refusal") readText(res); // 거절은 오류로 올린다
      lastAssistantSeq = seq;
      await saveMessage(p.threadId, seq++, "assistant", res.content, { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens || 0, cacheWrite: res.usage.cache_creation_input_tokens || 0 });
      messages.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "max_tokens") { p.send({ type: "text", delta: "\n(답이 길어 여기서 잘렸습니다. 이어서 물어보시면 계속합니다.)" }); break; }
      if (res.stop_reason !== "tool_use") break;

      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(uses.map(async (u) => {
        const input = (u.input || {}) as Record<string, unknown>;
        if (u.name === "margin_calc") { // 이익률 계산기 산식(computeSpecItem) — 쓰기 없음. 결과는 표 카드 + 모델에 JSON
          p.send({ type: "tool", toolUseId: u.id, name: u.name, label: "이익률 계산", status: "start" });
          const t0 = Date.now();
          try {
            if (!marginRef) marginRef = await loadMarginRef();
            const items = (Array.isArray(input.items) ? input.items : []) as Partial<MarginSpec>[];
            const ok: MarginResultItem[] = [], failed: string[] = [];
            for (const it of items.slice(0, 8)) {
              const spec: MarginSpec = {
                sku: typeof it.sku === "string" && it.sku.trim() ? it.sku.trim() : null, productName: String(it.productName || "").trim(), channel: String(it.channel || "").trim(),
                feeRatePct: typeof it.feeRatePct === "number" ? it.feeRatePct : null, priceBasis: it.priceBasis === "wholesale" || it.priceBasis === "custom" ? it.priceBasis : "retail",
                customTotal: typeof it.customTotal === "number" ? it.customTotal : null, discountPct: Number(it.discountPct) || 0,
                qty: Math.max(1, Math.round(Number(it.qty) || 1)), paidUnits: Math.max(0, Math.round(Number(it.paidUnits) || 1)), boxes: Math.max(1, Math.round(Number(it.boxes) || 1)),
                extraCosts: Array.isArray(it.extraCosts) ? it.extraCosts.map((e) => ({ label: String(e.label || "기타"), amount: Number(e.amount) || 0 })) : [],
              };
              try { ok.push(computeSpecItem(spec, marginRef)); } catch (e) { failed.push(`${spec.productName}/${spec.channel}: ${e instanceof Error ? e.message : String(e)}`); }
            }
            const ms = Date.now() - t0;
            if (ok.length) {
              const exp = (r: MarginResultItem, key: string) => r.expenses.find((e) => e.label.startsWith(key))?.amount ?? 0;
              const columns = ["시나리오", "매출(원)", "공급가액(원)", "상품원가(원)", "채널 수수료(원)", "택배비(원)", "아이스박스·운반(원)", "보냉비(원)", "기타(원)", "순이익(원)", "이익률(%)"];
              const rows = ok.map((r) => ({
                "시나리오": r.label, "매출(원)": r.revenue, "공급가액(원)": r.supplyValue, "상품원가(원)": exp(r, "상품원가"), "채널 수수료(원)": exp(r, "채널 수수료"),
                "택배비(원)": exp(r, "택배비"), "아이스박스·운반(원)": exp(r, "아이스박스"), "보냉비(원)": exp(r, "보냉비"),
                "기타(원)": r.expenses.filter((e) => !/^(상품원가|채널 수수료|택배비|아이스박스|보냉비)/.test(e.label)).reduce((s, e) => s + e.amount, 0),
                "순이익(원)": r.netProfit, "이익률(%)": r.marginPct,
              }));
              const title = `이익률 계산 — ${ok.length === 1 ? ok[0].label : `${ok.length}개 시나리오`}`;
              const sql = "-- 이익률 계산기 산식(코드 계산 — SQL 아님, 저장·루커 불가)";
              const { data } = await sb().from("report_tables").insert({ thread_id: p.threadId, tool_use_id: u.id, title, sql, columns, rows, row_count: rows.length, truncated: false, looker: null }).select("id").single();
              p.send({ type: "table", table: { id: String((data as { id?: string } | null)?.id || u.id), toolUseId: u.id, title, sql, columns, rows, rowCount: rows.length, truncated: false } });
            }
            p.send({ type: "tool", toolUseId: u.id, name: u.name, label: "이익률 계산", status: ok.length ? "ok" : "fail", ms });
            toolCount++;
            return { type: "tool_result" as const, tool_use_id: u.id, is_error: !ok.length, content: JSON.stringify({
              month: marginRef.month, results: ok.map((r) => ({ label: r.label, revenue: r.revenue, supplyValue: r.supplyValue, taxNote: r.taxNote, expenses: r.expenses, netProfit: r.netProfit, marginPct: r.marginPct })),
              failed, note: "숫자는 그대로 인용. 부피 미입력 상품은 2kg 가정, 별도 언급 없으면 1박스.",
            }) };
          } catch (e) {
            p.send({ type: "tool", toolUseId: u.id, name: u.name, label: "이익률 계산", status: "fail", ms: Date.now() - t0 });
            return { type: "tool_result" as const, tool_use_id: u.id, content: `오류: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
          }
        }
        if (u.name === "write_notice" || u.name === "cs_coach") { // 공지 작성기·CS 코치와 같은 함수(2026-10-22 대표: 비서에 연결) — 쓰기 없음
          const label = toolLabel(u.name, input);
          p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "start" });
          const t0 = Date.now();
          toolCount++;
          try {
            const left = deadlineAt - Date.now() - FINAL_RESERVE_MS;
            if (left < 20_000) throw new Error("남은 시간이 부족합니다 — 이어서 다시 요청해 주세요");
            const run: Promise<Record<string, unknown>> = u.name === "write_notice"
              ? generateNotice({
                  channel: String(input.channel || ""), text: String(input.text || ""),
                  refine: (NOTICE_REFINES as readonly string[]).includes(String(input.refine)) ? (input.refine as NoticeRefine) : null,
                  previous: typeof input.previous === "string" && input.previous.trim() ? input.previous : undefined,
                }).then((r) => ({ type: r.typeLabel, channel: String(input.channel || ""), limit: r.limit, length: r.text.length, draft: r.text, missing: r.missing.map((f) => f.label), optional_empty: r.optional.map((f) => f.label) }))
              : generateCsAdvice(String(input.query || "")).then((r) => ({ category: r.category, situation: r.situation, approach: r.approach, reply: r.reply, cautions: r.cautions, policy: r.policy, manualMissing: r.manualMissing }));
            const r = await withTimeout(run, Math.min(115_000, left));
            if (r === "timeout") throw new Error("작성 시간 초과");
            p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "ok", ms: Date.now() - t0 });
            return { type: "tool_result" as const, tool_use_id: u.id, content: JSON.stringify(r) };
          } catch (e) {
            p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "fail", ms: Date.now() - t0 });
            return { type: "tool_result" as const, tool_use_id: u.id, content: `오류: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
          }
        }
        if (isLiveTool(u.name)) { // 광고 API·재고·채널 상태 — 쓰기 없음. 표는 SQL 아님('-- ' 주석)으로 저장
          const label = liveToolLabel(u.name, input);
          p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "start" });
          const t0 = Date.now();
          toolCount++;
          try {
            const r = await withTimeout(runLiveTool(ctx.sb, live, u.name, input), u.name.startsWith("ad_") ? ADS_TIMEOUT_MS + 5_000 : TOOL_TIMEOUT_MS);
            if (r === "timeout") throw new Error("조회 시간 초과");
            for (const [i, t] of r.tables.entries()) {
              const tid = i === 0 ? u.id : `${u.id}#${i}`; // (thread_id, tool_use_id) 유일 — 두 번째 표부터 '#n'
              const { data, error } = await sb().from("report_tables").insert({ thread_id: p.threadId, tool_use_id: tid, title: t.title, sql: t.sql, columns: t.columns, rows: t.rows, row_count: t.rows.length, truncated: false, looker: null }).select("id").single();
              if (error) console.error("[chat] 표 저장 실패", error.message);
              p.send({ type: "table", table: { id: String((data as { id?: string } | null)?.id || tid), toolUseId: tid, title: t.title, sql: t.sql, columns: t.columns, rows: t.rows, rowCount: t.rows.length, truncated: false } });
            }
            p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "ok", ms: Date.now() - t0 });
            return { type: "tool_result" as const, tool_use_id: u.id, content: r.content };
          } catch (e) {
            p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "fail", ms: Date.now() - t0 });
            return { type: "tool_result" as const, tool_use_id: u.id, content: `오류: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
          }
        }
        const label = toolLabel(u.name, input);
        p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "start" });
        const t0 = Date.now();
        const limitMs = u.name === "search_text" ? SEARCH_TIMEOUT_MS : TOOL_TIMEOUT_MS;
        toolCount++;
        try {
          const before = ctx.sqlRuns.length;
          const out = await withTimeout(runTool(ctx, u.name, input), limitMs);
          if (out === "timeout") throw new Error(`조회 시간 초과(${Math.round(limitMs / 1000)}초)`);
          const ms = Date.now() - t0;
          if (u.name === "run_sql" && ctx.sqlRuns.length > before) {
            const run = ctx.sqlRuns[ctx.sqlRuns.length - 1];
            run.toolUseId = u.id;
            const { data, error } = await sb().from("report_tables").insert({
              thread_id: p.threadId, tool_use_id: u.id, title: run.title, sql: run.sql, columns: run.columns, rows: run.rows,
              row_count: run.rowCount, truncated: run.truncated, looker: run.looker ?? null,
            }).select("id").single();
            if (error) console.error("[chat] 표 저장 실패", error.message);
            p.send({ type: "table", table: { id: String((data as { id?: string } | null)?.id || u.id), toolUseId: u.id, title: run.title, sql: run.sql, columns: run.columns, rows: run.rows, rowCount: run.rowCount, truncated: run.truncated, looker: run.looker } });
          }
          p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "ok", ms });
          return { type: "tool_result" as const, tool_use_id: u.id, content: out };
        } catch (e) {
          const ms = Date.now() - t0;
          p.send({ type: "tool", toolUseId: u.id, name: u.name, label, status: "fail", ms });
          return { type: "tool_result" as const, tool_use_id: u.id, content: `오류: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
        }
      }));
      await saveMessage(p.threadId, seq++, "user", results);
      messages.push({ role: "user", content: results });
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (usage.input + usage.output + usage.cacheRead > 0) {
      await addAssistantUsage(usage.estUsd);
      await sb().from("report_threads").update({ updated_at: new Date().toISOString(), model, est_usd: (Number(thread.est_usd) || 0) + usage.estUsd }).eq("id", p.threadId);
    }
    console.log(`[chat] user=${p.user} thread=${p.threadId.slice(0, 8)} q="${text.slice(0, 40).replace(/\s+/g, " ")}" tools=${toolCount} ms=${elapsedMs} usd=${usage.estUsd}${downgraded ? " downgraded" : ""}${timedOut ? " timedOut" : ""}`);
  }

  p.send({ type: "done", model, usage, downgraded, timedOut, elapsedMs: Date.now() - startedAt, title, seq: lastAssistantSeq, dataDate });

  // 긴 스레드 접기 — 응답을 보낸 뒤, 남은 시간 안에서만
  try { if (deadlineAt - Date.now() > 40_000 && charsOf(messages) > COMPACT_AT_CHARS) await compactThread(thread, p.threadId, auxModel); }
  catch (e) { console.error("[chat] 요약 실패", e instanceof Error ? e.message : e); }
}

// 앞부분 요약 — 최근 사용자 메시지 KEEP_EXCHANGES 개 이전까지를 보조 모델로 1,500자 안에 접는다(도구 호출과 그 결과는 한 쌍으로 같은 쪽에 남게 사용자 글 경계에서 자른다)
async function compactThread(t: ThreadRow, threadId: string, auxModel: string): Promise<void> {
  const msgs = await loadMessages(threadId, t.compact_seq);
  const userTextSeqs = msgs.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.seq);
  if (userTextSeqs.length <= KEEP_EXCHANGES) return;
  const boundary = userTextSeqs[userTextSeqs.length - KEEP_EXCHANGES]; // 이 seq 부터 남긴다
  const old = msgs.filter((m) => m.seq < boundary);
  if (!old.length) return;
  const lines: string[] = [];
  for (const m of old) {
    for (const b of blocksOf(m.content)) {
      if (b.type === "text") lines.push(`${m.role === "user" ? "사용자" : "비서"}: ${String((b as { text?: string }).text || "").slice(0, 1500)}`);
      else if (b.type === "tool_use") { const u = b as Anthropic.ToolUseBlock; lines.push(`[도구 ${u.name}] ${toolLabel(u.name, (u.input || {}) as Record<string, unknown>)}${u.name === "run_sql" ? `\nSQL: ${String((u.input as { sql?: string })?.sql || "").slice(0, 600)}` : ""}`); }
      else if (b.type === "tool_result") { const r = b as Anthropic.ToolResultBlockParam; lines.push(`[결과] ${String(typeof r.content === "string" ? r.content : JSON.stringify(r.content)).slice(0, 400)}`); }
    }
  }
  const res = await anthropic.messages.create({
    model: auxModel, max_tokens: 1500,
    system: "아래 대화를 다음 턴의 모델이 이어받을 수 있게 한국어 평문으로 요약합니다. 반드시 남길 것: 사용자가 정의한 용어와 기준, 정해진 기간·채널·지표, 확인된 핵심 숫자(값 그대로), 아직 답하지 않은 요청, 사용자의 선호. 표 전체·SQL 전문은 넣지 않습니다. 1,500자 이내.",
    messages: [{ role: "user", content: `${t.summary ? `[기존 요약]\n${t.summary}\n\n[이어진 대화]\n` : ""}${lines.join("\n")}` }],
    ...effortParams(auxModel, "low"),
  }, { timeout: 30_000, maxRetries: 0 });
  const summary = readText(res, { allowTruncated: true }).trim().slice(-SUMMARY_MAX);
  if (!summary) return;
  const { error } = await sb().from("report_threads").update({ summary, compact_seq: boundary - 1 }).eq("id", threadId);
  if (error) throw error;
}
