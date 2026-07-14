import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./config";
import { getFeatureModelKey } from "./ai-model";
import { supabaseAdmin } from "./supabase";
import { SCHEMA_CATALOG, RUN_HERE_RELATIONS, LOOKER_RELATIONS } from "./report-schema";

// AI 커스텀 리포트 — 자연어 질문 → Postgres SQL 생성(+루커스튜디오용 SQL).
//  실행은 run_report(=report_ro 권한)로만. 정확도 위해 opus 고정(이익률 계산기와 동일 방식).
//  Node 런타임 전용(@anthropic-ai/sdk).

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ReportChart = { type: "bar" | "line" | "pie" | "none"; x?: string; series?: string[]; note?: string };
export type ReportLooker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
export type ReportUsage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type ReportPlan = {
  understood: string;         // 질문 해석 한 줄
  sql: string;                // 여기서 실행할 Postgres SELECT
  explanation: string;        // 결과 읽는 법 1~2줄
  chart?: ReportChart;        // (미사용) 저장 호환용 — 화면은 표만 표시
  looker: ReportLooker;       // 루커스튜디오용 SQL
  caveats: string[];          // 주의·가정
  usage?: ReportUsage;        // 토큰 사용량(캐시 포함)
};

// 편집 가능한 지침 저장(이익률 계산기와 동일 패턴: b2b_settings)
const PROMPT_KEY = "report_ai_prompt";

export const DEFAULT_REPORT_PROMPT = `당신은 씨몬스터(순살 생선 전문 이커머스)의 '데이터 조회 엔진'입니다.
사용자의 한국어 질문을 읽고, 아래 스키마를 근거로 **정확한 PostgreSQL 쿼리**를 만들어 매출·재고 데이터를 조회합니다.
당신은 해석·조언을 하는 컨설턴트가 아닙니다. 질문에 **정확히 대응하는 데이터만 충실히** 뽑고, 데이터에 근거하지 않은 판단·추천·추정·전망은 하지 않습니다.

[반드시 지킬 규칙]
1) **SELECT(또는 WITH ... SELECT) 단일 문**만 생성. INSERT/UPDATE/DELETE/DROP/ALTER/CREATE 등 절대 금지. 세미콜론으로 여러 문 나열 금지.
2) 아래 '조회 가능 관계'에 있는 테이블/뷰만 사용. 그 외(특히 전화·이름 PII)는 접근 금지.
3) 결과가 많을 수 있으면 적절히 GROUP BY/집계하고 ORDER BY + LIMIT 를 붙여 핵심만. 기본 LIMIT 200 권장.
4) 금액=원 단위 정수, 날짜는 order_date 등 실제 컬럼 사용. 한국어 별칭(AS "매출") 으로 사람이 읽기 좋게.
5) 고객 수는 COUNT(DISTINCT customer_key), 재구매 등 분석은 이미 만들어둔 분석 뷰(sales_group_repeat/sales_buyer_repeat 등)를 우선 활용.
6) **충실·최소**: 질문이 요구한 컬럼·집계만 SELECT. 요청하지 않은 파생지표(비중·순위·증감률·평균 등)나 부가 컬럼을 임의로 덧붙이지 말 것. 질문에 딱 맞는 최소한의 결과만.
7) **문자 그대로**: 질문이 모호해도 임의로 확장·추측하지 말 것. 가장 문자 그대로(literal)의 해석으로 조회하고, 불가피한 가정만 caveats 에 '사실'로 짧게 명시.
8) **무추정·무판단**: 데이터에 없는 값을 만들거나 보간·추정하지 말 것. 원인·전망·추천·평가·인사이트 같은 해석은 어떤 필드에도 넣지 말 것 — 오직 조회된 데이터와 그 정의(무엇을·어떤 단위로)만.

[루커스튜디오용 SQL(looker)]
- 루커스튜디오는 'looker_ro' 역할로 접속하며 아래 '루커 노출 뷰'만 볼 수 있음(원장 테이블·재고·products 는 못 봄).
- 질문을 루커 노출 뷰만으로 만들 수 있으면 → mode:"query", sql: 루커 커스텀쿼리로 붙일 SELECT.
- 원장/재고 등 뷰에 없는 데이터가 필요하면 → mode:"view", sql: "create or replace view sales_xxx as ... ; grant select on sales_xxx to looker_ro;" (사용자가 SQL Editor 에 적용 후 루커에서 사용). 뷰 이름은 sales_/inv_ 접두로 명확히.
- 애매하면 mode:"na".`;

const SCHEMA_BLOCK = `[스키마 카탈로그]
${SCHEMA_CATALOG}

[여기서 조회 가능한 관계(run-here)]
${RUN_HERE_RELATIONS.join(", ")}

[루커스튜디오 노출 뷰(looker_ro)]
${LOOKER_RELATIONS.join(", ")}`;

const OUTPUT_RULES = `[출력] 설명 없이 아래 JSON만 반환:
{
 "understood":"질문 해석 한 줄",
 "sql":"여기서 실행할 PostgreSQL SELECT (단일 문, 세미콜론 없이)",
 "explanation":"이 표가 '무엇을·어떤 단위로' 담는지의 사실 1줄(예: '채널별 3월 매출 합계, 원'). 해석·평가·조언 금지.",
 "looker":{"mode":"query|view|na","sql":"루커용 SQL(위 규칙)","note":"루커에서 쓰는 법"},
 "caveats":["집계 정의·데이터 한계 같은 '사실'만(예: '반품 제외'). 없으면 빈 배열."]
}
- sql 은 실제로 실행 가능한 완전한 쿼리. 컬럼 별칭은 한국어로.
- 결과는 표로만 보여주므로 차트/시각화 스펙은 만들지 말 것. SQL 정확성에 집중해 토큰을 아낄 것.
- **철저히 데이터 기반**: understood·explanation·caveats 는 모두 조회된 데이터의 '사실'(무엇을/단위/집계 정의/데이터 한계)만 담을 것. 원인·추천·의견·전망·인사이트 등 판단은 어떤 필드에도 절대 넣지 말 것. caveats 는 없으면 [].
- 이전 대화(assistant 의 이전 SQL)가 있으면, 새 질문이 그 결과를 '다듬는' 요청일 수 있음(예: "도매만 빼줘"·"월별로"·"상위 20개로"·"작년과 비교"). 그럴 땐 직전 SQL 을 기반으로 수정해 sql 을 다시 만들 것.`;

export async function getReportPrompt(): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", PROMPT_KEY).maybeSingle();
    if (error || !data) return DEFAULT_REPORT_PROMPT;
    const v = data.value as string | { text?: string } | null;
    const text = typeof v === "string" ? v : v?.text;
    return text && text.trim() ? text : DEFAULT_REPORT_PROMPT;
  } catch {
    return DEFAULT_REPORT_PROMPT;
  }
}

export async function setReportPrompt(prompt: string): Promise<void> {
  const sb = supabaseAdmin();
  if (!prompt || !prompt.trim()) {
    const { error } = await sb.from("b2b_settings").delete().eq("key", PROMPT_KEY);
    if (error) throw error;
    return;
  }
  const { error } = await sb.from("b2b_settings").upsert({ key: PROMPT_KEY, value: prompt, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 앱 방어 ①: 단일 SELECT만 허용.
export function assertSelectOnly(sql: string): string {
  const s = (sql || "").trim().replace(/;\s*$/, ""); // 끝 세미콜론 허용
  if (!/^(with|select)\b/i.test(s)) throw new Error("SELECT 쿼리만 실행할 수 있습니다.");
  if (s.includes(";")) throw new Error("여러 문장은 실행할 수 없습니다.");
  if (/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|call|do)\b/i.test(s))
    throw new Error("쓰기/DDL 구문은 실행할 수 없습니다.");
  return s;
}

// 앱 방어 ②: 참조 테이블이 화이트리스트(매출·재고)에 있는지 검증 — 그 외/PII/시스템 테이블 차단.
export function assertAllowedRelations(sql: string): void {
  const allow = new Set(RUN_HERE_RELATIONS.map((r) => r.toLowerCase()));
  // 내장함수의 '키워드 FROM' 오탐 제거: extract(month FROM x)·substring·trim·overlay·position(...)
  const scan = sql.replace(/\b(?:extract|substring|trim|overlay|position)\s*\([^()]*\)/gi, " NULL ");
  const ctes = new Set<string>();
  for (const m of scan.matchAll(/(?:\bwith\b|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(/gi)) ctes.add(m[1].toLowerCase());
  for (const m of scan.matchAll(/\b(?:from|join)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?(\s*\()?/gi)) {
    if (m[2]) continue;             // 뒤에 '(' → 집합반환 함수(generate_series 등) 허용
    const name = m[1].toLowerCase();
    if (name === "_sub") continue;
    if (!allow.has(name) && !ctes.has(name))
      throw new Error(`허용되지 않은 테이블 참조: '${name}' — 매출·재고 관계만 조회할 수 있습니다.`);
  }
}

// 단일 SELECT + 화이트리스트 통과한 정규화 SQL 반환.
export function validateReportSql(sql: string): string {
  const s = assertSelectOnly(sql);
  assertAllowedRelations(s);
  return s;
}

// 리포트용 모델 — /b2b/settings/ai 에서 조정. 미설정(inherit)이면 opus(정교) 기본(공통기본 sonnet 아님).
async function reportModel(): Promise<string> {
  const k = await getFeatureModelKey("report");
  return k !== "inherit" ? (MODELS[k] ?? MODELS.opus) : MODELS.opus;
}

export type ReportTurn = { q: string; sql: string };
export type ReportCorrection = { sql: string; error: string };

export async function planReport(question: string, history?: ReportTurn[], correction?: ReportCorrection): Promise<ReportPlan> {
  const [framework, model] = await Promise.all([getReportPrompt(), reportModel()]);
  // 후속 대화: 직전 질문·SQL 을 메시지로 넣어 '정제' 요청을 이해시킴(시스템 캐시는 그대로 유지)
  const msgs: Anthropic.MessageParam[] = [];
  for (const h of (history || []).slice(-3)) {
    msgs.push({ role: "user", content: `[질문]\n${h.q}` });
    msgs.push({ role: "assistant", content: JSON.stringify({ sql: h.sql }) });
  }
  msgs.push({ role: "user", content: `[질문]\n${question.trim()}` });
  // 자동 교정: 방금 SQL 이 DB 오류로 실패 → 오류를 주고 고쳐 다시 만들게 함
  if (correction) {
    msgs.push({ role: "assistant", content: JSON.stringify({ sql: correction.sql }) });
    msgs.push({ role: "user", content: `방금 그 SQL 이 PostgreSQL 오류로 실패했습니다:\n${correction.error}\n오류 원인을 고쳐, 같은 질문 의도의 올바른 단일 SELECT 로 다시 만들어 주세요. (없는 컬럼/함수·타입 캐스팅·GROUP BY·별칭 등은 스키마에 맞게 교정)` });
  }
  const resp = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    // 스키마·규칙(정적 대용량 prefix)은 프롬프트 캐시 → 반복 질문의 입력 토큰 대폭 절감(정확도 영향 0)
    system: [{ type: "text" as const, text: `${framework}\n\n${SCHEMA_BLOCK}\n\n${OUTPUT_RULES}`, cache_control: { type: "ephemeral" as const } }],
    messages: msgs,
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const plan = JSON.parse(cleaned) as ReportPlan;
  plan.sql = validateReportSql(plan.sql); // 단일 SELECT + 화이트리스트 검증 + 정규화
  const u = resp.usage;
  plan.usage = {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  return plan;
}
