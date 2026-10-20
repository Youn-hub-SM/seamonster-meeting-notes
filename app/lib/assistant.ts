// AI 데이터 비서 공용 모듈(2026-10-19 대화형 개편 뒤) — 설정(끄기·월 상한·월 누적), PII 마스킹, 도구 정의·실행(run_sql·schema·search_text·read_report·ask_user), usage 집계.
//  대화 엔진은 chat-assistant.ts(스레드 저장·스트리밍). 옛 '질문 1회 → JSON 보고서' 엔진(askAssistant)은 제거했다.
//  안전: 쓰기 도구 없음. run_sql 은 validateReportSql(단일 SELECT·화이트리스트) → run_report(SECURITY DEFINER) 그대로.
//   search_text 는 supabaseAdmin 직접 조회지만 읽는 컬럼을 코드가 고정하고(voc.customer 등 이름 컬럼 제외) 결과는 maskPii 로 마스킹.
//  비용: 기능 모델 = report(기본 fable). 보조(검색 결과 추리기) = opus+low. 월 상한(assistant_cap_usd, 기본 $60) 초과 시 전체 opus+low(downgraded).
//   끄기 = assistant_off "1". 월 누적 = assistant_usage_<YYYY-MM> {usd, questions}. Node 런타임 전용(@anthropic-ai/sdk).
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { getKv, setKv } from "./b2b-settings";
import { getFeatureModel, effortParams, readText, AiResponseError } from "./ai-model";
import { MODELS } from "./config";
import { validateReportSql } from "./report-ai";
import { BLOCKED_NOTE } from "./report-schema";
import { loadLiveSchema, schemaIndexText, describeTables, liveSchemaStatus } from "./report-live-schema";

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

// ── 화면 계약(AskResult) ──
export type AskLooker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
export type AskTable = { title: string; sql: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; looker?: AskLooker };
export type QuoteSource = "voc" | "inquiry" | "report" | "manual" | "request" | "activity";
export type AskQuote = { source: QuoteSource; date: string; title: string; text: string };
export type AskUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; estUsd: number; estNote: string };
export type AskToolLog = { name: string; label: string; ok: boolean; ms: number };
export class AssistantOffError extends Error {}

// ── 설정·월 누적(kv) ──
export const ASSISTANT_DEFAULT_CAP_USD = 60;
const KV_OFF = "assistant_off";
const KV_CAP = "assistant_cap_usd";
const usageKey = (ym: string) => `assistant_usage_${ym}`;
export const kstYm = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
export type AssistantMonthUsage = { usd: number; questions: number };

export async function getAssistantSettings(): Promise<{ off: boolean; capUsd: number }> {
  const [off, cap] = await Promise.all([getKv(KV_OFF), getKv(KV_CAP)]);
  const n = Number(cap);
  return { off: off === "1", capUsd: Number.isFinite(n) && n > 0 ? n : ASSISTANT_DEFAULT_CAP_USD };
}
export async function setAssistantSettings(p: { off?: boolean; capUsd?: number }): Promise<void> {
  if (p.off !== undefined) await setKv(KV_OFF, p.off ? "1" : "");
  if (p.capUsd !== undefined) await setKv(KV_CAP, String(p.capUsd));
}
export async function getAssistantMonthUsage(ym = kstYm()): Promise<AssistantMonthUsage> {
  const raw = await getKv(usageKey(ym));
  if (!raw) return { usd: 0, questions: 0 };
  try {
    const j = JSON.parse(raw) as Partial<AssistantMonthUsage>;
    return { usd: Number(j.usd) || 0, questions: Number(j.questions) || 0 };
  } catch { return { usd: 0, questions: 0 }; }
}
// 질문이 끝나면 누적(읽고-더하고-쓰기 — 동시 질문이 겹치면 한쪽이 덜 잡힐 수 있으나 상한 판단용이라 허용). 실패는 무시.
export async function addAssistantUsage(usd: number): Promise<void> {
  try {
    const ym = kstYm();
    const cur = await getAssistantMonthUsage(ym);
    await setKv(usageKey(ym), JSON.stringify({ usd: Math.round((cur.usd + usd) * 10000) / 10000, questions: cur.questions + 1 }));
  } catch { /* 누적 실패는 답에 영향 없음 */ }
}

// ── 개인정보 마스킹(검색 결과·인용에 적용) — export 해서 단독 테스트 가능 ──
//  전화: 휴대폰(010-0000-0000·01000000000·+82 10 …)·일반전화(02-000-0000·031-000-0000)·붙은 숫자 10~11자리.
//   '1,234원'·'2026-10-19'·주문번호 13자리 같은 것은 앞뒤 lookaround 로 건드리지 않는다.
//  이메일 → (이메일 생략). 주소: 시/도 + 시/군/구 + 로/길/동 + 번지 꼴 → (주소 생략).
//  이름: '고객명: 김철수' 같은 라벨 뒤와 '김철수님/씨/고객님' 꼴만 성만 남긴다(김**). 흔한 성 60여 개로 제한해 일반 단어 오탐을 줄인다.
const MOBILE_RE = /(?<![\d-])(?:\+?82[-\s.]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)/g;
const LANDLINE_RE = /(?<![\d-])0(?:2|[3-6]\d|70|80)[-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)/g;
const DIGITS_RE = /(?<![\d,.\-])\d{10,11}(?![\d,.])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ADDR_RE = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청?북|충청?남|전라?북|전라?남|경상?북|경상?남|제주)(?:특별시|광역시|특별자치시|특별자치도|도|시)?\s*(?:[가-힣]{1,8}(?:시|군|구)\s*){1,2}(?:[가-힣0-9]{1,12}(?:로|길|동|읍|면|리)\s*){1,3}\d[\d\-]*(?:번지|번길)?(?:\s*[A-Za-z가-힣0-9\-]{1,12}(?:동|호|층|빌딩|아파트|타워|오피스텔|빌라))*/g;
const SURNAMES = "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용";
const HONOR = "님|씨|고객님|선생님|사장님|대표님";
const NAME_TIGHT_RE = new RegExp(`(?<![가-힣])([${SURNAMES}])([가-힣]{2})(?=(?:${HONOR})(?![가-힣]))`, "g");
// 띄어 쓴 '김철수 님' — '이번에 고객님' 같은 조사 꼴 오탐은 뒤 두 글자의 끝 글자로 거른다
const NAME_SPACED_RE = new RegExp(`(?<![가-힣])([${SURNAMES}])([가-힣]{2})(?<![에은는이가을를도로께서의와과번])(?=\\s(?:${HONOR})(?![가-힣]))`, "g");
// 라벨 뒤 조사(은·는·이·가)는 띄어 쓴 경우에만 조사로 본다 — '수취인 이민준' 의 '이' 를 조사로 먹지 않게
const NAME_LABEL_RE = /(고객명|고객 이름|이름|성함|수취인|수령인|받는\s*분|주문자|구매자|보내는\s*분|신청자|작성자)\s*(?:[:：]|(?:은|는|이|가)(?=\s))?\s*([가-힣])[가-힣]{1,3}(?![가-힣])/g;

export function maskName(name: string | null | undefined): string {
  const s = (name || "").trim();
  if (!s) return "";
  return `${s[0]}**`;
}
export function maskPii(text: string, opts?: { names?: boolean }): string {
  if (!text) return "";
  let s = text
    .replace(EMAIL_RE, "(이메일 생략)")
    .replace(ADDR_RE, "(주소 생략)")
    .replace(MOBILE_RE, "(전화 생략)")
    .replace(LANDLINE_RE, "(전화 생략)")
    .replace(DIGITS_RE, "(전화 생략)");
  if (opts?.names !== false) {
    s = s.replace(NAME_LABEL_RE, (_m, label: string, first: string) => `${label}: ${first}**`)
      .replace(NAME_TIGHT_RE, "$1**")
      .replace(NAME_SPACED_RE, "$1**");
  }
  return s;
}

// ── 스키마 카탈로그 절 파싱(schema 도구) ──
//  카탈로그는 '## 그룹' 머리글과 'TABLE name — …'/'VIEW name — …' 블록(들여쓴 컬럼 줄·※ 줄이 이어짐, 빈 줄로 끝남)으로 돼 있다.
// ── 스키마(2026-10-20 구조 전환): DB 의 표·컬럼 주석을 읽는다(report-live-schema.ts). 차단 목록 밖은 전부 조회 가능 ──
//  프롬프트용 목록 = 이름 + 한 줄 설명(주석 첫 문장). 10분 캐시라 턴마다 비용이 들지 않는다.
export async function catalogIndex(sb: SupabaseClient): Promise<string> {
  const live = await loadLiveSchema(sb);
  return schemaIndexText(live);
}
export const PRIVATE_NOTE = BLOCKED_NOTE;

// ── 도구 정의(strict JSON schema) ──
export function toolDefs(strict: boolean): Anthropic.Tool[] {
  const s = strict ? { strict: true } : {};
  return [
    {
      name: "run_sql", ...s,
      description: "PostgreSQL SELECT 한 문을 읽기 전용으로 실행해 표를 얻습니다. 화이트리스트 테이블만. 결과 미리보기는 최대 40행(화면엔 1,000행까지 보입니다). 오류가 돌아오면 SQL 을 고쳐 다시 호출하세요.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["sql", "title", "looker_mode", "looker_sql", "looker_note"],
        properties: {
          sql: { type: "string", description: "단일 SELECT(세미콜론 없이). 컬럼 별칭은 한국어." },
          title: { type: "string", description: "표 제목(한국어, 예: '채널별 10월 매출')" },
          looker_mode: { type: ["string", "null"], enum: ["query", "view", "na", null], description: "루커스튜디오용 SQL 종류 — query(루커 노출 뷰만으로 같은 표), view(뷰 생성문 필요), na(불가·모름). 모르면 null" },
          looker_sql: { type: ["string", "null"], description: "루커용 SQL(커스텀쿼리 또는 create or replace view … ; grant select on … to looker_ro;). 없으면 null" },
          looker_note: { type: ["string", "null"], description: "루커에서 쓰는 법 한 줄. 없으면 null" },
        },
      },
    },
    {
      name: "schema", ...s,
      description: "테이블/뷰의 컬럼 설명을 스키마 카탈로그에서 돌려줍니다. SQL 을 쓰기 전에 필요한 테이블을 여러 개 한 번에 요청하세요.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["tables"],
        properties: { tables: { type: "array", items: { type: "string" }, description: "테이블/뷰 이름(소문자)" } },
      },
    },
    {
      name: "search_text", ...s,
      description: "글 본문 검색 — voc(고객의 소리 내용), inquiry(스마트스토어 문의 질문·답변), report(종합 리포트 본문), manual(CS 매뉴얼), request(생산 요청서 제목·메모), activity(업무 변경 이력). keyword 의 단어는 모두 포함(AND)돼야 하며, 결과는 최신순 발췌(300자). 개인정보는 마스킹돼 옵니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["sources", "keyword", "since", "until", "limit"],
        properties: {
          sources: { type: ["array", "null"], items: { type: "string", enum: ["voc", "inquiry", "report", "manual", "request", "activity"] }, description: "검색할 소스. null = 전부" },
          keyword: { type: ["string", "null"], description: "공백으로 나눈 단어 AND 검색. null = 기간만으로 최신순" },
          since: { type: ["string", "null"], description: "YYYY-MM-DD 부터" },
          until: { type: ["string", "null"], description: "YYYY-MM-DD 까지" },
          limit: { type: ["integer", "null"], description: "최대 건수(기본 20, 최대 30)" },
        },
      },
    },
    {
      name: "read_report", ...s,
      description: "종합 리포트 본문 1건 전문. daily 는 그 날짜(분석 대상일), weekly 는 주 시작(월요일), monthly 는 1일. 그 날짜가 없으면 가장 가까운 이전 리포트를 날짜와 함께 돌려줍니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["kind", "date"],
        properties: {
          kind: { type: "string", enum: ["daily", "weekly", "monthly"] },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
    {
      name: "ask_user", ...s,
      description: "되물을 때 사용자가 버튼으로 고르게 할 선택지를 붙입니다. 호출하면 조사가 멈추고 사용자의 답을 받은 뒤 이어집니다. 조사 시작 전이나 schema 확인 직후에만 쓰고, 다른 도구와 함께 호출하지 않습니다. 선택지가 필요 없으면 도구 없이 평문으로 되물어도 됩니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["question", "options"],
        properties: {
          question: { type: "string", description: "되묻는 문장 한 개(존댓말, 한 문장, 무엇이 왜 필요한지 짧게)" },
          options: { type: ["array", "null"], items: { type: "string" }, description: "사용자가 고를 선택지 2~4개(짧은 명사구). 자유 입력만 받으려면 null" },
        },
      },
    },
  ];
}

export function kstTodayLabel(): string {
  const d = new Date(Date.now() + 9 * 3600e3);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
  return `${d.toISOString().slice(0, 10)} (${wd})`;
}

// ── 단가(USD/1M) — analyst.priceOf 와 같은 표. Fable 은 단가 미확인이라 Opus 단가로 추정하고 estNote 로 밝힌다 ──
function priceOf(model: string): { in: number; out: number; cr: number; cw: number; approx: boolean } {
  if (/fable/.test(model)) return { in: 4, out: 20, cr: 0.2, cw: 5, approx: true };
  if (/opus-5/.test(model)) return { in: 4, out: 20, cr: 0.2, cw: 5, approx: false };
  if (/sonnet-5/.test(model)) return { in: 2, out: 10, cr: 0.2, cw: 2.5, approx: false };
  if (/haiku/.test(model)) return { in: 1, out: 5, cr: 0.1, cw: 1.25, approx: false };
  return { in: 3, out: 15, cr: 0.3, cw: 3.75, approx: false };
}
export const FABLE_NOTE = "Fable 단가 미확인 — Opus 단가 기준 추정";

export const retryable = (e: unknown) => e instanceof Anthropic.APIError && (e.status === 429 || e.status === 529 || (typeof e.status === "number" && e.status >= 500));
export const strictRejected = (e: unknown) => e instanceof Anthropic.APIError && e.status === 400 && /strict|input_schema|schema/i.test(e.message || "");
export const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([p, new Promise<"timeout">((res) => setTimeout(() => res("timeout"), ms))]);

// ── 한계값 ──
export const ASK_DEADLINE_MS = 270_000;   // 라우트 maxDuration 300 에서 응답 여유
const MAX_TOOL_ROUNDS = 8;
const FINAL_RESERVE = 120_000;            // 최종 답 턴에 남겨 둘 시간
export const TOOL_TIMEOUT_MS = 25_000;           // run_sql·schema·read_report
export const SEARCH_TIMEOUT_MS = 55_000;         // search_text(결과가 길면 보조 모델 추리기 포함)
const MODEL_ROWS = 40;                    // 모델에게 보여 줄 행 수
const MODEL_CELL = 80;                    // 모델에게 보여 줄 셀 글자 수
const SCREEN_ROWS = 1000;                 // 화면용 표 최대 행
const SEARCH_CONDENSE_AT = 9_000;         // 검색 결과가 이보다 길면 보조 모델로 3,000자로 줄인다
const SEARCH_CONDENSE_TO = 3_000;
const REPORT_MAX_CHARS = 20_000;
const QUOTE_MAX = 300;

// ── 도구 실행 ──
export type SqlRun = { id: string; title: string; sql: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; looker?: AskLooker; toolUseId?: string };
type SearchHit = { source: QuoteSource; date: string; title: string; text: string };
export type ToolCtx = { sb: SupabaseClient; question: string; sqlRuns: SqlRun[]; usage: AskUsage; auxModel: string; deadlineAt: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
const cellStr = (v: unknown) => {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > MODEL_CELL ? `${s.slice(0, MODEL_CELL)}…` : s;
};

async function toolRunSql(ctx: ToolCtx, input: Record<string, unknown>): Promise<string> {
  const title = String(input.title || "").trim().slice(0, 80) || `표 ${ctx.sqlRuns.length + 1}`;
  const safe = validateReportSql(String(input.sql || "")); // 검증 오류는 도구 결과로 돌아가 모델이 고친다
  const { data, error } = await ctx.sb.rpc("run_report", { q: safe });
  if (error) throw new Error(`쿼리 실행 오류: ${error.message}`);
  const all = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const columns = all.length ? Object.keys(all[0]) : [];
  const lm = String(input.looker_mode || "");
  const looker: AskLooker | undefined = lm === "query" || lm === "view"
    ? { mode: lm, sql: typeof input.looker_sql === "string" && input.looker_sql.trim() ? input.looker_sql.trim() : undefined, note: typeof input.looker_note === "string" && input.looker_note.trim() ? input.looker_note.trim() : undefined }
    : undefined;
  const run: SqlRun = { id: `t${ctx.sqlRuns.length + 1}`, title, sql: safe, columns, rows: all.slice(0, SCREEN_ROWS), rowCount: all.length, truncated: all.length > SCREEN_ROWS, looker: looker?.sql ? looker : undefined };
  ctx.sqlRuns.push(run);
  const preview = all.slice(0, MODEL_ROWS).map((r) => Object.fromEntries(columns.map((c) => [c, cellStr(r[c])])));
  return JSON.stringify({ id: run.id, title, rowCount: all.length, shown: preview.length, note: all.length > MODEL_ROWS ? `앞 ${MODEL_ROWS}행만 표시(화면엔 ${Math.min(all.length, SCREEN_ROWS)}행). 전체가 필요하면 집계·정렬·LIMIT 로 좁히세요.` : undefined, columns, rows: preview });
}

async function toolSchema(ctx: ToolCtx, input: Record<string, unknown>): Promise<string> {
  const names = (Array.isArray(input.tables) ? input.tables : []).map((t) => String(t).trim().toLowerCase().replace(/^public\./, "")).filter(Boolean).slice(0, 12);
  if (!names.length) throw new Error("tables 가 비어 있습니다.");
  const live = await loadLiveSchema(ctx.sb);
  const { found, missing, all } = describeTables(live, names);
  const parts = [...found];
  if (missing.length) parts.push(`없는 이름: ${missing.join(", ")} — 조회 가능한 표·뷰: ${all.join(", ")}`);
  if (!live.fromDb) parts.push("(DB 스키마 조회가 실패해 손 설명으로 답했습니다 — 컬럼 자료형은 생략됨)");
  // 진단(2026-10-20): 목록이 비는 사고가 있어 출처·행 수·마지막 오류를 답에 남긴다 — 관리자가 대화에서 바로 본다
  const st = liveSchemaStatus();
  parts.push(`[스키마 출처] ${live.fromDb ? "DB 주석" : "손 설명"} · 표·뷰 ${live.relations.size}개 · 컬럼 행 ${st.lastRows}${st.lastError ? ` · 마지막 오류: ${st.lastError}` : ""}`);
  return parts.join("\n\n");
}

// PostgREST or() 필터에 넣을 단어 — 구문 문자(쉼표·괄호·따옴표)와 LIKE 와일드카드를 뺀다
const cleanWord = (w: string) => w.replace(/[,()"'\\%_*]/g, "").trim();
const words = (kw: string | null) => (kw || "").split(/\s+/).map(cleanWord).filter((w) => w.length >= 1).slice(0, 5);
const dayOf = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
const excerpt = (text: string, ws: string[]): string => {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= QUOTE_MAX) return t;
  const low = t.toLowerCase();
  let idx = -1;
  for (const w of ws) { const i = low.indexOf(w.toLowerCase()); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  const start = idx < 0 ? 0 : Math.max(0, Math.min(idx - 100, t.length - QUOTE_MAX));
  return `${start > 0 ? "…" : ""}${t.slice(start, start + QUOTE_MAX)}…`;
};
const SOURCES: QuoteSource[] = ["voc", "inquiry", "report", "manual", "request", "activity"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any;
function applyWords(q: AnyQuery, cols: string[], ws: string[]): AnyQuery {
  for (const w of ws) q = q.or(cols.map((c) => `${c}.ilike.%${w}%`).join(","));
  return q;
}
function applyDate(q: AnyQuery, col: string, since: string | null, until: string | null, ts: boolean): AnyQuery {
  if (since) q = q.gte(col, ts ? `${since}T00:00:00+09:00` : since);
  if (until) q = q.lte(col, ts ? `${until}T23:59:59+09:00` : until);
  return q;
}
async function rowsOf(q: AnyQuery, label: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${label} 조회 실패: ${error.message}`);
  return (data || []) as Record<string, unknown>[];
}

// 글 본문 검색 — 소스별로 코드가 정한 컬럼만 읽고(이름 컬럼 제외), 발췌 뒤 maskPii.
async function searchText(sb: SupabaseClient, input: { sources: QuoteSource[]; keyword: string | null; since: string | null; until: string | null; limit: number }): Promise<SearchHit[]> {
  const ws = words(input.keyword);
  const { since, until, limit } = input;
  const tasks: Promise<SearchHit[]>[] = [];
  const has = (s: QuoteSource) => input.sources.includes(s);

  if (has("voc")) tasks.push((async () => {
    let q: AnyQuery = sb.from("voc").select("id, received_at, category, status, product, purchase_place, content, resolution, cause, fault, sentiment");
    q = applyWords(q, ["content", "resolution", "cause"], ws);
    q = applyDate(q, "received_at", since, until, false).order("received_at", { ascending: false }).limit(limit);
    return (await rowsOf(q, "VOC")).map((r) => ({
      source: "voc" as const, date: dayOf(r.received_at),
      title: `VOC ${r.category || ""} · ${r.status || ""}${r.product ? ` · ${r.product}` : ""}${r.purchase_place ? ` · ${r.purchase_place}` : ""}`,
      text: excerpt([`${r.content || ""}`, r.resolution ? `처리: ${r.resolution}` : "", r.cause ? `원인: ${r.cause}` : "", r.fault ? `귀책: ${r.fault}` : ""].filter(Boolean).join(" / "), ws),
    }));
  })());

  if (has("inquiry")) tasks.push((async () => {
    let q: AnyQuery = sb.from("channel_inquiries").select("id, channel, kind, category, title, product_name, question, answer, answered, asked_at");
    q = applyWords(q, ["question", "answer", "title"], ws);
    q = applyDate(q, "asked_at", since, until, true).order("asked_at", { ascending: false }).limit(limit);
    return (await rowsOf(q, "채널 문의")).map((r) => ({
      source: "inquiry" as const, date: dayOf(r.asked_at),
      title: `${r.channel || ""} ${r.kind || ""}${r.category ? ` · ${r.category}` : ""}${r.title ? ` · ${r.title}` : r.product_name ? ` · ${r.product_name}` : ""}`,
      text: excerpt(`문의: ${r.question || ""}${r.answer ? ` / 답변: ${r.answer}` : r.answered ? "" : " / (미답변)"}`, ws),
    }));
  })());

  if (has("report")) tasks.push((async () => {
    let d: AnyQuery = sb.from("analyst_reports").select("report_date, report_md").eq("status", "ok").not("report_md", "is", null);
    d = applyWords(d, ["report_md"], ws);
    d = applyDate(d, "report_date", since, until, false).order("report_date", { ascending: false }).limit(limit);
    let p: AnyQuery = sb.from("analyst_period_reports").select("period, report_date, period_end, report_md").eq("status", "ok").not("report_md", "is", null);
    p = applyWords(p, ["report_md"], ws);
    p = applyDate(p, "report_date", since, until, false).order("report_date", { ascending: false }).limit(limit);
    const [dr, pr] = await Promise.all([rowsOf(d, "일일 리포트"), rowsOf(p, "주간·월간 리포트")]);
    return [
      ...dr.map((r) => ({ source: "report" as const, date: dayOf(r.report_date), title: `일일 종합 리포트 ${dayOf(r.report_date)}`, text: excerpt(String(r.report_md || ""), ws) })),
      ...pr.map((r) => ({ source: "report" as const, date: dayOf(r.report_date), title: `${r.period === "weekly" ? "주간" : "월간"} 종합 리포트 ${dayOf(r.report_date)}~${dayOf(r.period_end)}`, text: excerpt(String(r.report_md || ""), ws) })),
    ];
  })());

  if (has("manual")) tasks.push((async () => {
    let q: AnyQuery = sb.from("cs_manual").select("id, title, category, content, updated_at");
    q = applyWords(q, ["title", "content"], ws);
    q = q.order("updated_at", { ascending: false }).limit(limit);
    return (await rowsOf(q, "CS 매뉴얼")).map((r) => ({
      source: "manual" as const, date: dayOf(r.updated_at), title: `CS 매뉴얼 · ${r.category || ""} · ${r.title || ""}`, text: excerpt(String(r.content || ""), ws),
    }));
  })());

  if (has("request")) tasks.push((async () => {
    let q: AnyQuery = sb.from("production_requests").select("id, req_no, title, memo, status, purpose, request_date, due_date, assignee");
    q = applyWords(q, ["title", "memo"], ws);
    q = applyDate(q, "request_date", since, until, false).order("request_date", { ascending: false }).limit(limit);
    return (await rowsOf(q, "생산 요청서")).map((r) => ({
      source: "request" as const, date: dayOf(r.request_date),
      title: `생산 요청 ${r.req_no || ""} · ${r.status || ""}${r.purpose ? ` · ${r.purpose}` : ""}${r.due_date ? ` · 마감 ${dayOf(r.due_date)}` : ""}`,
      text: excerpt([r.title ? `제목: ${r.title}` : "", r.memo ? `메모: ${r.memo}` : ""].filter(Boolean).join(" / ") || "(제목·메모 없음)", ws),
    }));
  })());

  if (has("activity")) tasks.push((async () => {
    let q: AnyQuery = sb.from("activity_log").select("id, event_type, summary, order_no, actor, meta, created_at");
    q = applyWords(q, ["summary"], ws);
    q = applyDate(q, "created_at", since, until, true).order("created_at", { ascending: false }).limit(limit);
    return (await rowsOf(q, "변경 이력")).map((r) => {
      const meta = r.meta && typeof r.meta === "object" ? JSON.stringify(r.meta).slice(0, 120) : "";
      return {
        source: "activity" as const, date: dayOf(r.created_at),
        title: `변경 이력 · ${r.event_type || ""}${r.order_no ? ` · ${r.order_no}` : ""}${r.actor ? ` · ${r.actor}` : ""}`,
        text: excerpt(`${r.summary || ""}${meta ? ` / ${meta}` : ""}`, ws),
      };
    });
  })());

  const hits = (await Promise.all(tasks)).flat()
    .map((h) => ({ ...h, title: maskPii(h.title).slice(0, 120), text: maskPii(h.text).slice(0, QUOTE_MAX + 2) }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return hits.slice(0, limit);
}

// 검색 결과가 길면 보조 모델(opus·low)로 질문과 관련된 부분만 추려 3,000자로 — 원문 발췌만 남기고 새로 쓰지 않게
async function condenseHits(ctx: ToolCtx, raw: string): Promise<string> {
  const left = ctx.deadlineAt - Date.now();
  if (left < FINAL_RESERVE + 45_000) return raw.slice(0, SEARCH_CONDENSE_AT); // 시간이 없으면 단순 절단
  try {
    const res = await anthropic.messages.create({
      model: ctx.auxModel, max_tokens: 4000,
      system: `검색 결과(JSON)에서 아래 질문과 관련된 항목만 골라 ${SEARCH_CONDENSE_TO}자 이내로 줄입니다. 같은 JSON 형식({"results":[{"source","date","title","text"}]})을 유지하고, text 는 원문 발췌를 그대로 두되 관련 없는 문장만 잘라냅니다. 요약하거나 새로 쓰지 않습니다. JSON 만 출력합니다.`,
      messages: [{ role: "user", content: `[질문]\n${ctx.question}\n\n[검색 결과]\n${raw}` }],
      ...effortParams(ctx.auxModel, "low"),
    }, { timeout: 35_000, maxRetries: 0 });
    addUsage(ctx.usage, ctx.auxModel, res.usage);
    const text = readText(res, { allowTruncated: true }).replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    return text ? `${text.slice(0, SEARCH_CONDENSE_TO + 500)}\n(검색 결과가 길어 질문과 관련된 부분만 추렸습니다)` : raw.slice(0, SEARCH_CONDENSE_AT);
  } catch {
    return raw.slice(0, SEARCH_CONDENSE_AT);
  }
}

async function toolSearchText(ctx: ToolCtx, input: Record<string, unknown>): Promise<string> {
  const srcIn = Array.isArray(input.sources) ? input.sources.map((s) => String(s)) : [];
  const sources = srcIn.length ? SOURCES.filter((s) => srcIn.includes(s)) : [...SOURCES];
  if (!sources.length) throw new Error(`sources 는 ${SOURCES.join("|")} 중에서 고르세요.`);
  const keyword = typeof input.keyword === "string" && input.keyword.trim() ? input.keyword.trim() : null;
  const since = validDate(input.since) ? input.since : null;
  const until = validDate(input.until) ? input.until : null;
  if (!keyword && !since && !until) throw new Error("keyword 나 기간(since/until) 중 하나는 필요합니다.");
  const lim = Number(input.limit);
  const limit = Number.isFinite(lim) && lim > 0 ? Math.min(30, Math.floor(lim)) : 20;
  const hits = await searchText(ctx.sb, { sources, keyword, since, until, limit });
  if (!hits.length) return JSON.stringify({ count: 0, results: [], note: "검색 결과 없음 — 키워드를 줄이거나 기간을 넓혀 보세요." });
  const raw = JSON.stringify({ count: hits.length, results: hits });
  return raw.length > SEARCH_CONDENSE_AT ? condenseHits(ctx, raw) : raw;
}

async function toolReadReport(sb: SupabaseClient, input: Record<string, unknown>): Promise<string> {
  const kind = String(input.kind || "");
  const date = input.date;
  if (!validDate(date)) throw new Error("date 는 YYYY-MM-DD 형식이어야 합니다.");
  if (!["daily", "weekly", "monthly"].includes(kind)) throw new Error("kind 는 daily|weekly|monthly 중 하나입니다.");
  let q: AnyQuery = kind === "daily"
    ? sb.from("analyst_reports").select("report_date, report_md, model")
    : sb.from("analyst_period_reports").select("report_date, period_end, report_md, model").eq("period", kind);
  q = q.eq("status", "ok").not("report_md", "is", null).lte("report_date", date).order("report_date", { ascending: false }).limit(1);
  const rows = await rowsOf(q, "종합 리포트");
  const r = rows[0];
  if (!r) return JSON.stringify({ requested: date, found: null, note: `${date} 이전의 ${kind} 리포트가 없습니다.` });
  const found = dayOf(r.report_date);
  const md = maskPii(String(r.report_md || ""), { names: false });
  return JSON.stringify({
    requested: date, found, period_end: r.period_end ? dayOf(r.period_end) : undefined,
    note: found === date ? undefined : `${date} 리포트가 없어 가장 가까운 이전(${found}) 리포트입니다.`,
    report_md: md.length > REPORT_MAX_CHARS ? `${md.slice(0, REPORT_MAX_CHARS)}\n…(리포트가 길어 ${REPORT_MAX_CHARS}자에서 잘랐습니다)` : md,
  });
}

export function toolLabel(name: string, input: Record<string, unknown>): string {
  if (name === "run_sql") return String(input.title || "SQL 조회").slice(0, 80);
  if (name === "schema") return `스키마: ${(Array.isArray(input.tables) ? input.tables : []).map(String).join(", ").slice(0, 80)}`;
  if (name === "search_text") {
    const src = Array.isArray(input.sources) && input.sources.length ? input.sources.map(String).join("·") : "전체";
    const kw = typeof input.keyword === "string" && input.keyword.trim() ? ` "${input.keyword.trim().slice(0, 40)}"` : "";
    const range = [input.since, input.until].filter((v) => typeof v === "string" && v).join("~");
    return `글 검색(${src})${kw}${range ? ` ${range}` : ""}`;
  }
  if (name === "read_report") return `${{ daily: "일일", weekly: "주간", monthly: "월간" }[String(input.kind)] || String(input.kind)} 리포트 ${String(input.date || "")}`;
  if (name === "margin_calc") {
    const items = Array.isArray(input.items) ? (input.items as { productName?: string; channel?: string }[]) : [];
    return items.length === 1 ? `이익률 계산: ${String(items[0].productName || "")} · ${String(items[0].channel || "")}`.slice(0, 80) : `이익률 계산: 시나리오 ${items.length}개`;
  }
  return name;
}

export async function runTool(ctx: ToolCtx, name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "run_sql") return toolRunSql(ctx, input);
  if (name === "schema") return toolSchema(ctx, input);
  if (name === "search_text") return toolSearchText(ctx, input);
  if (name === "read_report") return toolReadReport(ctx.sb, input);
  throw new Error(`알 수 없는 도구: ${name}`);
}

// ── usage 집계(모델별 단가로 호출마다 더한다) ──
export function addUsage(acc: AskUsage, model: string, u: Anthropic.Usage): void {
  const inp = u.input_tokens || 0, out = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  acc.input += inp; acc.output += out; acc.cacheRead += cr; acc.cacheWrite += cw;
  const p = priceOf(model);
  acc.estUsd = Math.round((acc.estUsd + (inp * p.in + out * p.out + cr * p.cr + cw * p.cw) / 1e6) * 10000) / 10000;
  if (p.approx) acc.estNote = FABLE_NOTE;
}
