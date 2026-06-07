import { createClient, SupabaseClient } from "@supabase/supabase-js";

// 서버 전용 Supabase 클라이언트 (service role).
// 브라우저 코드에 import 하면 빌드 타임에 SUPABASE_SERVICE_ROLE_KEY 가 번들에 포함되니
// 반드시 API 라우트 / 서버 컴포넌트에서만 사용할 것.

let _client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("환경변수 NEXT_PUBLIC_SUPABASE_URL 가 설정되어 있지 않습니다.");
  if (!key) throw new Error("환경변수 SUPABASE_SERVICE_ROLE_KEY 가 설정되어 있지 않습니다.");

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// supabase-js 에러는 표준 Error 인스턴스가 아니라 { message, details, hint, code } 객체.
// 그래서 `err instanceof Error` 가 false → 메시지를 못 뽑는 문제 방지.
export function extractErrorMsg(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; hint?: string; details?: string; code?: string };
    const parts = [e.message, e.details, e.hint && `(hint: ${e.hint})`, e.code && `[${e.code}]`].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}
