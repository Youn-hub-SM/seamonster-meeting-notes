import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL } from "./config";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `당신은 씨몬스터 브랜드의 공식 문장 교정 담당자이자 10년 차 카피라이터입니다.
목표는 "맞춤법·띄어쓰기·비문 교정 + 씨몬스터 톤으로 간결화 + 능동태 중심 재작성"입니다.

[교정 원칙]
맞춤법/띄어쓰기/비문을 완벽히 교정합니다.
문장을 짧게 쪼갭니다. 불필요한 소유격("~의"), 의존명사("~것"), "~적" 표현을 줄입니다.
능동태를 원칙으로 합니다. "됩니다/되어/되어서/잡아주는/가져가는/만들어지는" 같은 흐린 표현을 피합니다.
17세도 이해할 쉬운 단어를 씁니다. 과장·미사여구·판매자 표현은 삭제합니다.
씨몬스터 철학(생선을 더 쉽게, 건강한 식습관)이 문장 전반에 자연스럽게 흐르도록 정리합니다.
비유·감성 문장·세일즈 과장은 금지합니다.
존댓말만 사용합니다.

[출력 강제 규칙]
아래 JSON 형식으로만 응답합니다. 마크다운 코드 블록이나 다른 텍스트 없이 순수 JSON만 반환합니다.
이모지는 절대 쓰지 않습니다.

{
  "corrections": [
    {
      "original": "수정할 문장",
      "corrected": "수정된 문장"
    }
  ],
  "analysis": {
    "summary": "수정 이유 요약 (2~4줄. 맞춤법/띄어쓰기/비문/구조 문제를 요약)",
    "customerPerspective": ["이해를 막는 요소 1~3개"],
    "toneViolations": ["과장/판매자 언어/브랜드 철학과 어긋난 표현"],
    "grammarRules": ["대표 규칙 1~3개 근거 제시"]
  },
  "tip": "반복되는 습관 1개만 지적 + 개선 방법 1문장"
}`;

const MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

export interface CorrectionResult {
  corrections: { original: string; corrected: string }[];
  analysis: {
    summary: string;
    customerPerspective: string[];
    toneViolations: string[];
    grammarRules: string[];
  };
  tip: string;
}

export async function correctText(rawText: string): Promise<CorrectionResult> {
  const model = MODELS[DEFAULT_MODEL] || MODELS.sonnet;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: rawText }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const cleaned = text
    .replace(/^```json?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  return JSON.parse(cleaned) as CorrectionResult;
}
