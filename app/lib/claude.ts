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

  // 팀 공유 용어집(회의 화면에서 편집) — 있으면 프롬프트에 주입
  prompt += await meetingTermsPromptBlock();

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

// ── OKR 1:1 체크인 — 편집된 회의록에서 비공개/공개 요약과 할 일을 분리 추출 ──
//  비공개판: 전체 논의(개인 피드백 포함) 정리 — 본인 개인 소통방(아사나 비공개 프로젝트)용.
//  공개판: OKR 진행·결정 중심, 개인적·민감한 대화 제외 — 공통 OKR 관리 프로젝트용.
export type OkrExtractResult = {
  privateSummary: string;
  publicSummary: string;
  todos: { text: string; scope: "personal" | "okr" }[];
};

export async function extractOkrFromMeeting(editedText: string): Promise<OkrExtractResult> {
  const model = await getFeatureModel("meeting");
  const system = `한국어 1:1 OKR 회의록 분리 어시스턴트. 입력은 이미 정리·편집된 회의록이다. 순수 JSON만 반환.

형식:
{"privateSummary":"비공개 요약","publicSummary":"공개 요약","todos":[{"text":"할 일(행동형 문장)","scope":"personal|okr"}]}

규칙:
[privateSummary] 전체 내용을 충실히 정리(개인 피드백·고민·사적 논의 포함). 불릿 형식의 여러 줄 허용.
[publicSummary] 팀 전체가 보는 요약. OKR 진행 상황·수치·결정 사항만. 개인 피드백, 사적·민감한 대화, 인사 관련 내용은 제외. 불릿 형식.
[todos] 실행 과제만. text 는 "~하기" 행동형으로. scope 는 OKR(회사 목표) 달성에 직접 관련되면 "okr", 개인 업무·개인 요청이면 "personal". 애매하면 "personal".
할 일이 없으면 빈 배열. JSON 외 텍스트 금지.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: editedText }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as OkrExtractResult;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as OkrExtractResult;
    throw new Error("분리 추출 결과를 해석하지 못했습니다. 회의록을 조금 줄여 다시 시도해 주세요.");
  }
}
