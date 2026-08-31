import Anthropic from "@anthropic-ai/sdk";
import { TEAM_MEMBERS, COMPANY_CONTEXT } from "./config";
import { getFeatureModel } from "./ai-model";
import { meetingTermsPromptBlock } from "./meeting-terms";
import { supabaseAdmin } from "./supabase";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 회의록 정리 기초 프롬프트(지침). /b2b/settings/ai 에서 편집하면 b2b_settings 'meeting_prompt' 에 저장돼
// 즉시 반영됨. 팀원 정보·회사 맥락은 시스템이 자동으로 덧붙이므로 여기에 넣지 않는다.
export const DEFAULT_MEETING_PROMPT = `한국어 회의 녹음(STT) 정리 전문 어시스턴트. 입력 즉시 분석 후 순수 JSON만 반환.

형식:
{"title":"회의 제목","date":"YYYY-MM-DD","body":"주제별 마크다운 정리본"}

[body 작성법 — 주제별 정리]
- 맨 위에 도입 문단 1~3문장: 회의 날짜·참석자·다룬 주제를 서술형으로.
- 이어서 주제별 섹션: "## 주제명" 아래에 논의 배경·근거를 짧은 서술 문단으로 쓰고, 세부 항목·비교·수치는 "- " 불릿으로. 핵심 용어·결정·수치는 **볼드**.
- 섹션 사이에는 "---" 구분선 한 줄.
- 마지막 섹션은 반드시 "## 결론 및 다음 단계" — 모든 결정·행동을 "- **주제**: 내용" 불릿로 모은다. 보류 건은 (보류) 표기.
- 문어체 서술("~하기로 했다", "~로 확정하였다"). 잡담·중복·감정 제외. 수치·조건은 원문 그대로. 발언에 없는 내용 추측 금지. 빈약해도 임의 보완 없이 그대로.
[공통] 발언자 임의추정 금지. 기밀·전략도 수정 없이 의미 압축.`;

const MEETING_PROMPT_KEY = "meeting_prompt";

// 저장된 회의록 프롬프트(없거나 빈 값이면 기본값).
export async function getMeetingPrompt(): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", MEETING_PROMPT_KEY).maybeSingle();
    if (error || !data) return DEFAULT_MEETING_PROMPT;
    const v = data.value as { text?: string } | string | null;
    const text = typeof v === "string" ? v : v?.text;
    return text && text.trim() ? text : DEFAULT_MEETING_PROMPT;
  } catch {
    return DEFAULT_MEETING_PROMPT;
  }
}
// 빈 값 저장 → 설정 삭제(기본값 복원).
export async function setMeetingPrompt(text: string): Promise<void> {
  const sb = supabaseAdmin();
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    await sb.from("b2b_settings").delete().eq("key", MEETING_PROMPT_KEY);
    return;
  }
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: MEETING_PROMPT_KEY, value: { text: trimmed }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

async function buildSystemPrompt(): Promise<string> {
  let prompt = await getMeetingPrompt();

  const activeMembers = TEAM_MEMBERS.filter((m) => m.name !== "예시이름");
  if (activeMembers.length > 0) {
    const memberList = activeMembers.map((m) => `- ${m.name}: ${m.role}`).join("\n");
    prompt += `\n\n[팀원 정보]\n회의에 자주 참석하는 팀원:\n${memberList}\n이 이름이 언급되면 해당 역할에 맞게 담당자를 지정하세요.`;
  }

  if (COMPANY_CONTEXT) {
    prompt += `\n\n[추가 맥락]\n${COMPANY_CONTEXT}`;
  }

  // 팀 공유 용어집(회의 화면에서 편집) — 있으면 프롬프트에 주입
  prompt += await meetingTermsPromptBlock();

  return prompt;
}

interface ClaudeResult {
  title: string;
  date: string;
  body: string;
}

export async function summarizeMeeting(rawText: string): Promise<ClaudeResult> {
  const model = await getFeatureModel("meeting");

  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192, // 긴 회의(결정·To-Do 많음)에서 JSON 이 잘려 파싱 실패하던 것 방지
    system: await buildSystemPrompt(),
    messages: [{ role: "user", content: rawText }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const cleaned = text
    .replace(/^```json?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as ClaudeResult;
  } catch {
    // 모델이 앞뒤 문장을 덧붙이거나 형식을 살짝 어긴 경우 — 첫 { ~ 마지막 } 만 떼어 재시도
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as ClaudeResult;
    throw new Error("정리 결과 형식을 해석하지 못했습니다. 내용이 너무 길거나 형식이 특이하면 나눠서 시도해 주세요.");
  }
}

