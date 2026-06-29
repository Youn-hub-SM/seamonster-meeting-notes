// 설문 응답 수집 — VOC 클레임과 분리. Tally 등에서 들어온 폼 응답을 통째로 보존.
export interface SurveyAnswer { label: string; value: string }

export interface SurveyResponse {
  id: string;
  source: string;
  form_id: string | null;
  form_name: string | null;
  submission_id: string | null;
  respondent: string | null;
  submitted_at: string | null;
  answers: SurveyAnswer[];
  summary: string | null;
  photos: string[];
  created_at: string;
}

// 질문·답변을 미리보기/검색용 텍스트로
export function summarizeAnswers(answers: SurveyAnswer[]): string {
  return answers.map((a) => (a.label ? `${a.label}: ${a.value}` : a.value)).filter(Boolean).join("\n");
}

// 응답자 추정(이름/이메일/연락처 라벨)
export function findRespondent(answers: SurveyAnswer[]): string | null {
  const m = answers.find((a) => /(이름|성함|이메일|연락처|전화|닉네임)/.test((a.label || "").replace(/\s/g, "")));
  return m?.value?.trim() || null;
}
