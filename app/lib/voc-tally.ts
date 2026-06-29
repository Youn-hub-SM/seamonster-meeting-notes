import { supabaseAdmin } from "./supabase";

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
