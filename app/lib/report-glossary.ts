// AI 비서 — 회사 용어 사전(report_glossary, migration 140). 서버 전용.
//  한 번 정한 정의를 모든 대화의 시스템 프롬프트에 넣어 다시 묻지 않게 한다. 쓰기는 화면(사람)만 — 비서는 propose_term 으로 제안만.
import { supabaseAdmin } from "./supabase";

export type GlossaryTerm = { id: string; term: string; definition: string; createdBy: string | null; updatedBy: string | null; createdAt: string; updatedAt: string };
type Row = { id: string; term: string; definition: string; created_by: string | null; updated_by: string | null; created_at: string; updated_at: string };

const MAX_TERMS_IN_PROMPT = 80;
const toTerm = (r: Row): GlossaryTerm => ({ id: r.id, term: r.term, definition: r.definition, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at });

export const PENDING_140 = "DB 준비 전입니다 — supabase/migrations/140_report_glossary_feedback.sql 을 적용하세요.";
export function isPending140(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? "");
  return /report_(glossary|feedback)/.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

export async function listGlossary(): Promise<GlossaryTerm[]> {
  const { data, error } = await supabaseAdmin().from("report_glossary").select("*").order("term");
  if (error) throw error;
  return ((data || []) as Row[]).map(toTerm);
}

// 사전이 비었거나 표가 없으면 빈 문자열 — 비서는 사전 없이 동작한다
export async function glossaryPromptBlock(): Promise<string> {
  try {
    const terms = (await listGlossary()).slice(0, MAX_TERMS_IN_PROMPT);
    if (!terms.length) return "";
    return `[회사 용어 사전 — 사용자가 정해 둔 정의. 이 용어는 묻지 말고 이 정의로 조사합니다]\n${terms.map((t) => `- ${t.term}: ${t.definition}`).join("\n")}`;
  } catch { return ""; }
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function upsertGlossary(p: { id?: string; term: string; definition: string; user: string }): Promise<GlossaryTerm> {
  const term = clean(p.term, 60), definition = clean(p.definition, 600);
  if (!term) throw new Error("용어를 입력하세요.");
  if (!definition) throw new Error("정의를 입력하세요.");
  const sb = supabaseAdmin();
  if (p.id) {
    const { data, error } = await sb.from("report_glossary").update({ term, definition, updated_by: p.user, updated_at: new Date().toISOString() }).eq("id", p.id).select("*").single();
    if (error) throw dupErr(error, term);
    return toTerm(data as Row);
  }
  // 같은 용어(대소문자 무시)가 있으면 정의를 덮어쓴다 — 화면 '사전에 저장'이 두 번 눌려도 한 줄
  const { data: ex, error: exErr } = await sb.from("report_glossary").select("id").ilike("term", term).maybeSingle();
  if (exErr) throw exErr;
  if (ex) return upsertGlossary({ id: (ex as { id: string }).id, term, definition, user: p.user });
  const { data, error } = await sb.from("report_glossary").insert({ term, definition, created_by: p.user, updated_by: p.user }).select("*").single();
  if (error) throw dupErr(error, term);
  return toTerm(data as Row);
}
const dupErr = (e: { code?: string; message?: string }, term: string) => (e.code === "23505" ? new Error(`'${term}'은 이미 있는 용어입니다. 목록에서 고치세요.`) : e);

export async function deleteGlossary(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("report_glossary").delete().eq("id", id);
  if (error) throw error;
}
