import { supabaseAdmin } from "./supabase";
import { findRespondent, summarizeAnswers, type SurveyAnswer } from "./surveys";

// Tally 연동 설정 — b2b_settings 키-값에 저장(코드/깃에 두지 않음).
//  - tally_signing_secret: 웹훅(push) 서명 검증용 (선택)
//  - tally_api_key: API(pull) 인증 토큰
//  - tally_form_id: 가져올 폼 ID
//  - tally_import_cursor: 마지막으로 가져온 제출 시각(ISO) — 증분 가져오기용

async function getVal(key: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", key).maybeSingle();
    if (error || !data) return null;
    const v = data.value as { v?: string; secret?: string } | string | null;
    const s = typeof v === "string" ? v : (v?.v ?? v?.secret);
    return s && String(s).trim() ? String(s).trim() : null;
  } catch {
    return null;
  }
}
async function setVal(key: string, value: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key, value: { v: value.trim() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 웹훅 서명 시크릿 (기존 호환: value 가 {secret} 형태일 수도 있음)
export const getTallySecret = () => getVal("tally_signing_secret");
export const setTallySecret = (s: string) => setVal("tally_signing_secret", s);

// API(pull) 설정
export const getTallyApiKey = () => getVal("tally_api_key");
export const setTallyApiKey = (s: string) => setVal("tally_api_key", s);
export const getTallyFormId = () => getVal("tally_form_id");
export const setTallyFormId = (s: string) => setVal("tally_form_id", s);
export const getTallyCursor = () => getVal("tally_import_cursor");
export const setTallyCursor = (s: string) => setVal("tally_import_cursor", s);

const API = "https://api.tally.so";

export async function tallyFetch(path: string, apiKey: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Tally API ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

// ── 제출(submission) → 설문 응답 행(survey_responses) ── 가져오기(/api/voc/tally/import)와 신청자 문자(form-sms.ts)가 함께 쓴다.
export type TallyQ = { id: string; type?: string; title?: string };
type TallyResp = { questionId: string; answer?: unknown; formattedAnswer?: unknown };
export type TallySub = { id: string; submittedAt?: string; responses?: TallyResp[] };

function stringify(a: unknown): string {
  if (a == null) return "";
  if (Array.isArray(a)) return a.map(stringify).filter(Boolean).join(", ");
  if (typeof a === "object") { try { return JSON.stringify(a); } catch { return ""; } }
  return String(a);
}

// 폼이 제각각이라 모든 Q&A 를 그대로 보존, 파일은 photos 로 분리.
export function mapTallySubmission(sub: TallySub, qmap: Map<string, TallyQ>, formId: string): Record<string, unknown> {
  const answers: SurveyAnswer[] = [];
  const photos: string[] = [];
  for (const r of sub.responses || []) {
    const q: TallyQ = qmap.get(r.questionId) || { id: "" };
    const title = (q.title || "").trim();
    const type = (q.type || "").toUpperCase();
    if (type.includes("FILE") || type.includes("UPLOAD")) {
      if (Array.isArray(r.answer)) for (const it of r.answer) { const u = it && typeof it === "object" ? (it as { url?: string }).url : null; if (u) photos.push(u); }
      const fa = stringify(r.formattedAnswer);
      if (fa) answers.push({ label: title || "첨부", value: fa });
      continue;
    }
    const ans = r.formattedAnswer != null && r.formattedAnswer !== "" ? stringify(r.formattedAnswer) : stringify(r.answer);
    if (!ans && !title) continue;
    answers.push({ label: title, value: ans });
  }
  return {
    source: "tally",
    form_id: formId,
    submission_id: sub.id,
    submitted_at: sub.submittedAt || null,
    respondent: findRespondent(answers),
    answers,
    summary: summarizeAnswers(answers),
    photos,
  };
}

// 저장된 API 키로 볼 수 있는 탈리 폼 목록
export async function listTallyForms(apiKey: string): Promise<{ id: string; name: string }[]> {
  const json = await tallyFetch("/forms", apiKey);
  const items: unknown[] = Array.isArray(json) ? json : (json.items || json.forms || []);
  return items.map((f) => {
    const o = f as { id?: string; name?: string; title?: string };
    return { id: o.id || "", name: o.name || o.title || o.id || "(이름 없음)" };
  }).filter((f) => f.id);
}
