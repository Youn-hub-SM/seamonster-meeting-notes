import { supabaseAdmin } from "./supabase";

// Tally 웹훅 서명 시크릿 — b2b_settings('tally_signing_secret') 에 저장.
// 코드/깃에 두지 않고 설정 화면에서만 등록. 마스킹해서 표시.
const KEY = "tally_signing_secret";

export async function getTallySecret(): Promise<string | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    if (error || !data) return null;
    const v = data.value as { secret?: string } | string | null;
    const s = typeof v === "string" ? v : v?.secret;
    return s && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

export async function setTallySecret(secret: string): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: KEY, value: { secret: secret.trim() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}
