import { supabaseAdmin } from "./supabase";

// 회의정리봇 공유 용어집 — b2b_settings kv 'meeting_terms'({ list: [{term, note?}] }).
//  · 모든 구성원이 함께 편집(전체 게이팅 안에서 공유). 중복(대소문자·공백 무시)은 등록 안 됨.
//  · 회의 요약 프롬프트에 '[자주 쓰는 용어]' 블록으로 주입 → AI 가 표기·인식에 반영.
//  · 별도 마이그레이션 불필요(기존 b2b_settings 재사용).

const KEY = "meeting_terms";

export type MeetingTerm = { term: string; note?: string };

const norm = (s: string) => (s ?? "").trim().toLowerCase();

export async function getMeetingTerms(): Promise<MeetingTerm[]> {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    if (error || !data) return [];
    const v = data.value as { list?: MeetingTerm[] } | MeetingTerm[] | null;
    const list = Array.isArray(v) ? v : v?.list;
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is MeetingTerm => !!x && typeof x.term === "string" && x.term.trim() !== "")
      .map((x) => ({ term: x.term.trim(), ...(x.note && String(x.note).trim() ? { note: String(x.note).trim() } : {}) }));
  } catch {
    return [];
  }
}

async function save(list: MeetingTerm[]): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key: KEY, value: { list }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 추가 — 중복(대소문자·공백 무시)이면 실패. 저장은 가나다/알파벳 정렬.
export async function addMeetingTerm(term: string, note?: string): Promise<{ ok: boolean; error?: string; terms: MeetingTerm[] }> {
  const t = (term ?? "").trim();
  const terms = await getMeetingTerms();
  if (!t) return { ok: false, error: "용어를 입력하세요.", terms };
  if (t.length > 100) return { ok: false, error: "용어가 너무 깁니다 (100자 이내).", terms };
  if (terms.some((x) => norm(x.term) === norm(t))) return { ok: false, error: "이미 등록된 용어입니다.", terms };
  const n = (note ?? "").trim().slice(0, 300);
  const next = [...terms, { term: t, ...(n ? { note: n } : {}) }].sort((a, b) => a.term.localeCompare(b.term, "ko"));
  await save(next);
  return { ok: true, terms: next };
}

export async function removeMeetingTerm(term: string): Promise<MeetingTerm[]> {
  const terms = await getMeetingTerms();
  const next = terms.filter((x) => norm(x.term) !== norm(term));
  await save(next);
  return next;
}

// 회의 요약 시스템 프롬프트에 붙일 블록. 용어 없으면 빈 문자열.
export async function meetingTermsPromptBlock(): Promise<string> {
  const terms = await getMeetingTerms();
  if (!terms.length) return "";
  const lines = terms.map((x) => (x.note ? `- ${x.term}: ${x.note}` : `- ${x.term}`)).join("\n");
  return `\n\n[자주 쓰는 용어]\n팀이 자주 쓰는 고유 용어·표현입니다. 녹취가 비슷하게 잘못 들렸더라도 아래 표기로 인식·표기하세요.\n${lines}`;
}
