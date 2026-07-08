import Anthropic from "@anthropic-ai/sdk";
import { TEAM_MEMBERS, COMPANY_CONTEXT } from "./config";
import { getFeatureModel } from "./ai-model";
import { supabaseAdmin } from "./supabase";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 회의록 정리 기초 프롬프트(지침). /b2b/settings/ai 에서 편집하면 b2b_settings 'meeting_prompt' 에 저장돼
// 즉시 반영됨. 팀원 정보·회사 맥락은 시스템이 자동으로 덧붙이므로 여기에 넣지 않는다.
export const DEFAULT_MEETING_PROMPT = `한국어 회의 녹음(STT) 정리 전문 어시스턴트. 입력 즉시 분석 후 순수 JSON만 반환.

형식:
{"title":"회의 제목","date":"YYYY-MM-DD","timelineSummary":[{"time":"00:11~02:29","content":"핵심 한 줄"}],"decisions":[{"category":"범주","decided":["하기로 한 것"],"rejected":["안 하기로 한 것"],"pending":["보류 건"]}],"todos":[{"assignee":"담당자","task":"과제","deadline":"기한"}]}

규칙:
[시간순 요약] 시간순 정리. 타임코드 없으면 "1","2","3" 사용. 한 줄 요약만. 잡담·중복·감정·해석·추측 금지. 수치는 그대로. 여러 주제는 큰 흐름 기준으로 묶기.
[결론] 하기로/안하기로/보류를 범주별 정리. 의견·조언 금지, 결정 사실만. 미확정은 [보류]. 없으면 빈 배열.
[To-Do] 행동 단위 분리. 기한 없으면 deadline 생략(추정 금지). 담당자 불명확 시 "담당자 미정".
[공통] 존댓말. 짧고 명확. 서론/총평/미사여구 금지. 발언자 임의추정 금지. 기밀·전략도 수정 없이 의미 압축. 빈약해도 임의 보완 없이 그대로.`;

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

  return prompt;
}

interface ClaudeResult {
  title: string;
  date: string;
  timelineSummary: { time: string; content: string }[];
  decisions: {
    category: string;
    decided: string[];
    rejected: string[];
    pending: string[];
  }[];
  todos: { assignee: string; task: string; deadline?: string }[];
}

export async function summarizeMeeting(rawText: string): Promise<ClaudeResult> {
  const model = await getFeatureModel("meeting");

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: await buildSystemPrompt(),
    messages: [{ role: "user", content: rawText }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const cleaned = text
    .replace(/^```json?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  return JSON.parse(cleaned) as ClaudeResult;
}
