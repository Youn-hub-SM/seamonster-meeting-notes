import { supabaseAdmin } from "./supabase";

// DB 로그인 계정(app_users). 미들웨어에서 import 하지 말 것(서버 라우트 전용).
export type AppUser = { id: string; name: string; active: boolean; created_at: string };

// 로그인 검증용 — 활성 계정의 이름·비밀번호. 테이블 미적용이면 빈 배열.
export async function getActiveDbUsers(): Promise<{ name: string; password: string }[]> {
  try {
    const { data, error } = await supabaseAdmin().from("app_users").select("name,password").eq("active", true);
    if (error || !data) return [];
    return data as { name: string; password: string }[];
  } catch {
    return [];
  }
}

export async function listUsers(): Promise<AppUser[]> {
  const { data, error } = await supabaseAdmin().from("app_users").select("id,name,active,created_at").order("created_at");
  if (error) throw error;
  return (data || []) as AppUser[];
}

export async function addUser(name: string, password: string, by?: string): Promise<void> {
  const { error } = await supabaseAdmin().from("app_users").insert({ name: name.trim(), password: password.trim(), created_by: by || null });
  if (error) throw error;
}

export async function deleteUser(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("app_users").delete().eq("id", id);
  if (error) throw error;
}

export async function setUserActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabaseAdmin().from("app_users").update({ active }).eq("id", id);
  if (error) throw error;
}
