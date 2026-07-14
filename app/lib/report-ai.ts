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
  chart: ReportChart;         // 추천 시각화
  looker: ReportLooker;       // 루커스튜디오용 SQL
  caveats: string[];          // 주의·가정
  usage?: ReportUsage;        // 토큰 사용량(캐시 포함)
};

// 편집 가능한 지침 저장(이익률 계산기와 동일 패턴: b2b_settings)
const PROMPT_KEY = "report_ai_prompt";

export const DEFAULT_REPORT_PROMPT = `당신은 씨몬스터(순살 생선 전문 이커머스)의 '데이터 분석 어시스턴트'입니다.
사용자의 한국어 질문을 읽고, 아래 스키마를 근거로 **정확한 PostgreSQL 쿼리**를 만들어 매출·재고 데이터를 조회합니다.

[반드시 지킬 규칙]
1) **SELECT(또는 WITH ... SELECT) 단일 문**만 생성. INSERT/UPDATE/DELETE/DROP/ALTER/CREATE 등 절대 금지. 세미콜론으로 여러 문 나열 금지.
2) 아래 '조회 가능 관계'에 있는 테이블/뷰만 사용. 그 외(특히 전화·이름 PII)는 접근 금지.
3) 결과가 많을 수 있으면 적절히 GROUP BY/집계하고 ORDER BY + LIMIT 를 붙여 핵심만. 기본 LIMIT 200 권장.
4) 금액=원 단위 정수, 날짜는 order_date 등 실제 컬럼 사용. 한국어 별칭(AS "매출") 으로 사람이 읽기 좋게.
5) 고객 수는 COUNT(DISTINCT customer_key), 재구매 등 분석은 이미 만들어둔 분석 뷰(sales_group_repeat/sales_buyer_repeat 등)를 우선 활용.
6) 질문이 모호하면 합리적으로 해석하되 caveats 에 가정을 명시.

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
 "explanation":"결과 읽는 법 1~2줄(무엇을 어떤 단위로 보여주는지)",
 "chart":{"type":"bar|line|pie|none","x":"x축 컬럼명","series":["값 컬럼명",...],"note":""},
 "looker":{"mode":"query|view|na","sql":"루커용 SQL(위 규칙)","note":"루커에서 쓰는 법"},
 "caveats":["주의·가정(있으면)"]
}
- sql 은 실제로 실행 가능한 완전한 쿼리. 컬럼 별칭은 한국어로.
- chart.x/series 는 sql 의 SELECT 별칭과 정확히 일치(대소문자·한글 그대로). 차트 종류는 데이터 형태에 맞게 신중히 고를 것:
   · line = 시계열만. x가 날짜/연월/주차 같은 '기간'이고, SQL이 그 기간 오름차순 정렬이며, 한 기간당 값 1개일 때만. **랭킹(ORDER BY 값 DESC)이나 2차원 집계(예: SKU×주차)에는 절대 line 을 쓰지 말 것.**
   · bar = 카테고리·랭킹 비교(채널별/SKU별/상품군별 상위 N 등). x=범주 라벨, 값 큰 순 정렬.
   · pie = 소수(≤8개) 항목의 비중.
   · none = 행이 많거나(수십 개 이상), x축이 하나로 깔끔히 안 떨어지거나(예: SKU와 주차를 동시에 가진 결과), 표로 보는 게 더 명확할 때. **애매하면 none.**
- 랭킹/Top-N 질문이면 line 금지 → bar(범주 x, 값 큰 순) 또는 none.
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
