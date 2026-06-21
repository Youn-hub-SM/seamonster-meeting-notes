import Anthropic from "@anthropic-ai/sdk";
import { getCsModel } from "./ai-model";
import { fetchManualEntries, assembleManual, DEFAULT_CS_MANUAL } from "./cs-manual";
import { supabaseAdmin } from "./supabase";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 코치 지침(역할·코칭 방식·최우선 규칙) — 편집 가능한 '기초 프롬프트'.
// b2b_settings 의 'cs_prompt' 키에 저장. 미설정/오류 시 아래 기본값 사용.
// '지식'(매뉴얼)은 DB(cs_manual)에서 주입되고, 출력 JSON 형식(OUTPUT_RULES)은 파서가 의존하므로 코드 고정.
export const DEFAULT_CS_PROMPT = `당신은 씨몬스터(Sea Monster) CS 응대 직원을 돕는 'CS 코치'입니다.
직원이 주로 묻는 것은 "지금 이 상황에서 나는 어떻게 행동해야 하지?" 입니다.
입력은 고객 문의 원문일 수도 있고, "고객이 2번째로 녹았다고 연락왔는데 어떻게 해야 해?" 같은
직원 본인의 상황 설명·질문일 수도 있습니다. 어느 쪽이든 '직원이 지금 어떻게 행동해야 하는지'를 코치합니다.

코칭의 핵심 형태:
"지금 매뉴얼상 이러이러하다 → 그러니 너는 이렇게 행동해라."
→ 반드시 (1) 이 상황에 적용되는 매뉴얼 근거를 먼저 짚고, (2) 그 근거에 따라 직원이 취할 구체적 행동을 지시합니다.
조언(situation·policy·approach·cautions)은 직원에게 말하듯, reply(답변 초안)는 고객에게 보낼 문장으로 작성합니다.

상황에 매뉴얼이 부분적으로만 적용될 때(예: '2번째 반복'처럼 매뉴얼에 명시 안 된 변형)는,
매뉴얼이 다루는 부분은 그대로 안내하고, 매뉴얼에 없는 부분은 지어내지 말고 그 사실을 짚어주세요
(예: "반복 건에 대한 별도 기준은 매뉴얼에 없으니, 상급자 확인 또는 매뉴얼 추가가 필요합니다").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[최우선 규칙]
아래 매뉴얼에 없는 내용은 절대 추측하거나 생성하지 않습니다.
상황 전체가 매뉴얼과 무관하면 manualMissing 을 true 로 하고,
답변 초안은 "해당 내용은 현재 매뉴얼에 없습니다. 매뉴얼 추가 요청을 해주세요!" 로 합니다.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[응대 매뉴얼 — 아래 내용만 근거로 사용]
`;

// 출력 규칙 — 고정.
const OUTPUT_RULES = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[출력 규칙]
반드시 아래 JSON 형식으로만 응답합니다. 마크다운이나 다른 텍스트 없이 순수 JSON만 반환합니다.
조언(situation·approach·cautions·policy)은 '응대 직원'에게 말하는 어투로,
reply(답변 초안)는 '고객'에게 보낼 어투로 작성합니다.

{
  "category": "문의 유형 (예: 배송지연, 가시발견, 상품문의, 교환/환불, 이유식, 추천 등)",
  "situation": "① 상황 진단 — 지금 무슨 상황이고 고객 감정 상태는 어떤지, 직원이 무엇에 주의해야 하는지 1~2문장",
  "policy": "② 적용 매뉴얼·기준 — '지금 매뉴얼은 이렇다' 부분. 이 상황에 적용되는 매뉴얼 근거(정책·기준·절차)를 요약. 관련 매뉴얼이 있으면 반드시 채우고, 정말 관련 매뉴얼이 없을 때만 빈 문자열",
  "approach": ["③ 이렇게 행동하세요 — 위 매뉴얼 근거에 따라 직원이 지금 취해야 할 구체적 행동 2~4개 ('~하세요' 형태의 행동 지시)"],
  "reply": "④ 추천 답변 초안 — 고객에게 바로 보낼 수 있는 답변 전문 (복사해서 바로 쓸 수 있는 수준)",
  "cautions": ["⑤ 주의·리스크 — 하지 말아야 할 말이나 빠지기 쉬운 함정 1~3개"],
  "manualMissing": false
}

상황 전체가 매뉴얼과 무관할 경우:
{
  "category": "매뉴얼 미등록",
  "situation": "이 상황은 현재 매뉴얼에 응대 기준이 없습니다.",
  "policy": "",
  "approach": ["임의로 답하지 말고, 매뉴얼 추가 요청 후 정확한 기준을 확인해 행동하세요."],
  "reply": "해당 내용은 현재 매뉴얼에 없습니다. 매뉴얼 추가 요청을 해주세요!",
  "cautions": ["매뉴얼에 없는 내용을 추측해서 답하지 마세요."],
  "manualMissing": true
}`;

export interface CsAdvice {
  category: string;
  situation: string;     // ① 상황 진단
  approach: string[];    // ② 응대 방향·톤
  reply: string;         // ③ 추천 답변 초안 (복붙용)
  cautions: string[];    // ④ 주의·리스크
  policy: string;        // ⑤ 적용 정책·보상 기준 (없으면 "")
  manualMissing: boolean;
}

// ── 편집 가능한 코치 지침(기초 프롬프트) — b2b_settings 'cs_prompt' ──
const CS_PROMPT_KEY = "cs_prompt";

export async function getCsPrompt(): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("b2b_settings")
      .select("value")
      .eq("key", CS_PROMPT_KEY)
      .maybeSingle();
    if (error || !data) return DEFAULT_CS_PROMPT;
    const v = data.value as string | { text?: string } | null;
    const text = typeof v === "string" ? v : v?.text;
    return text && text.trim() ? text : DEFAULT_CS_PROMPT;
  } catch {
    return DEFAULT_CS_PROMPT;
  }
}

// 빈 문자열로 저장하면 설정을 지워 기본값으로 복원.
export async function setCsPrompt(prompt: string): Promise<void> {
  const sb = supabaseAdmin();
  if (!prompt || !prompt.trim()) {
    const { error } = await sb.from("b2b_settings").delete().eq("key", CS_PROMPT_KEY);
    if (error) throw error;
    return;
  }
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: CS_PROMPT_KEY, value: prompt, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

export async function generateCsAdvice(query: string): Promise<CsAdvice> {
  const model = await getCsModel();

  // 코치 지침(편집 가능) + 지식베이스(매뉴얼, DB) + 출력 규칙(고정) 으로 시스템 프롬프트 조립.
  // DB 미적용/오류 시에도 멈추지 않도록 각각 코드 기본값으로 폴백.
  const framework = await getCsPrompt();
  let manualText: string;
  try {
    manualText = assembleManual(await fetchManualEntries());
  } catch (err) {
    console.error("[cs] 매뉴얼 DB 조회 실패 — 기본 매뉴얼로 폴백:", err);
    manualText = assembleManual(DEFAULT_CS_MANUAL);
  }
  const systemPrompt = framework + manualText + OUTPUT_RULES;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: query }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const cleaned = text
    .replace(/^```json?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as Partial<CsAdvice>;
  // 모델이 일부 필드를 빠뜨려도 화면이 깨지지 않도록 정규화
  return {
    category: parsed.category || "기타",
    situation: parsed.situation || "",
    approach: Array.isArray(parsed.approach) ? parsed.approach.filter(Boolean) : [],
    reply: parsed.reply || "",
    cautions: Array.isArray(parsed.cautions) ? parsed.cautions.filter(Boolean) : [],
    policy: parsed.policy || "",
    manualMissing: Boolean(parsed.manualMissing),
  };
}
