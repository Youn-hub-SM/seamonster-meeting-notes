import { supabaseAdmin } from "./supabase";

// 내부도구 허브에 다는 외부 링크(현재: GitBook 매뉴얼). b2b_settings 'gitbook_url'.
// 코드 수정·재배포 없이 /b2b/설정 에서 URL 을 넣고 바꿀 수 있음.

const GITBOOK_KEY = "gitbook_url";

export async function getGitbookUrl(): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("b2b_settings")
      .select("value")
      .eq("key", GITBOOK_KEY)
      .maybeSingle();
    if (error || !data) return "";
    const v = data.value as string | { url?: string } | null;
    const url = typeof v === "string" ? v : v?.url;
    return (url || "").trim();
  } catch {
    return "";
  }
}

export async function setGitbookUrl(url: string): Promise<void> {
  const sb = supabaseAdmin();
  const u = (url || "").trim();
  if (!u) {
    const { error } = await sb.from("b2b_settings").delete().eq("key", GITBOOK_KEY);
    if (error) throw error;
    return;
  }
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: GITBOOK_KEY, value: u, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}
