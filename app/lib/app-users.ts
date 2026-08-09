import { supabaseAdmin } from "./supabase";
import type { AppRole } from "./b2b-auth";

// DB 로그인 계정(app_users). 미들웨어에서 import 하지 말 것(서버 라우트 전용).
export type AppUser = { id: string; name: string; active: boolean; role: AppRole; created_at: string };

// role 컬럼(088) 미적용 환경 폴백 — 컬럼명이 에러에 보이면 그 컬럼만 빼고 재시도(코드베이스 공통 패턴).
function isMissingRole(err: { message?: string } | null): boolean {
  return !!err?.message && /role/i.test(err.message);
}
function toRole(v: unknown): AppRole {
  return v === "factory" ? "factory" : "internal";
}
type Rows = Record<string, unknown>[] | null;

// 로그인 검증용 — 활성 계정의 이름·비밀번호·역할. 테이블 미적용이면 빈 배열.
export async function getActiveDbUsers(): Promise<{ name: string; password: string; role: AppRole }[]> {
  try {
    const sb = supabaseAdmin();
    const res = await sb.from("app_users").select("name,password,role").eq("active", true);
    const alt = isMissingRole(res.error) ? await sb.from("app_users").select("name,password").eq("active", true) : null;
    const rows = (alt ? alt.data : res.data) as Rows;
    if ((alt ? alt.error : res.error) || !rows) return [];
    return rows.map((u) => ({ name: String(u.name), password: String(u.password), role: toRole(u.role) }));
  } catch {
    return [];
  }
}

export async function listUsers(): Promise<AppUser[]> {
  const sb = supabaseAdmin();
  const res = await sb.from("app_users").select("id,name,active,role,created_at").order("created_at");
  const alt = isMissingRole(res.error) ? await sb.from("app_users").select("id,name,active,created_at").order("created_at") : null;
  const err = alt ? alt.error : res.error;
  if (err) throw err;
  const rows = ((alt ? alt.data : res.data) || []) as NonNullable<Rows>;
  return rows.map((u) => ({
    id: String(u.id), name: String(u.name), active: !!u.active, role: toRole(u.role), created_at: String(u.created_at),
  }));
}

export async function addUser(name: string, password: string, by?: string, role: AppRole = "internal"): Promise<void> {
  const sb = supabaseAdmin();
  const row: Record<string, unknown> = { name: name.trim(), password: password.trim(), created_by: by || null, role };
  let { error } = await sb.from("app_users").insert(row);
  if (isMissingRole(error)) {
    // 088 미적용 — 역할 없이 저장되면 internal 로 동작한다. factory 계정은 마이그레이션 후에 만들어야 한다.
    if (role !== "internal") throw new Error("역할 컬럼이 없습니다. supabase/migrations/088_app_users_role.sql 을 먼저 적용하세요.");
    delete row.role;
    ({ error } = await sb.from("app_users").insert(row));
  }
  if (error) throw error;
}

// 구분·비밀번호 변경(계정 관리 화면). 역할은 다음 로그인부터 적용된다(토큰에 실림).
export async function updateUser(id: string, patch: { role?: AppRole; password?: string }): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.role === "internal" || patch.role === "factory") row.role = patch.role;
  if (patch.password && patch.password.trim()) row.password = patch.password.trim();
  if (Object.keys(row).length === 0) return;
  const { error } = await supabaseAdmin().from("app_users").update(row).eq("id", id);
  if (isMissingRole(error)) throw new Error("역할 컬럼이 없습니다. supabase/migrations/088_app_users_role.sql 을 먼저 적용하세요.");
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
