// B2B 사용자 인증 — 비밀번호로 사용자를 구분.
//
// 환경변수:
//   B2B_PASSWORD          기존 단일 비밀번호 → "관리자" 로 취급 (하위 호환)
//   B2B_USERS             "이름:비밀번호,이름:비밀번호,..." 형식. 예) "지인:pw1,예지:pw2,현석:pw3"
//
// 비밀번호 자체가 신원이므로 사용자 간 비밀번호는 서로 달라야 한다.
// middleware(Edge)와 라우트 핸들러 양쪽에서 import — Node 전용 API 사용 금지.

export type B2BUser = { name: string; password: string };

export function getB2BUsers(): B2BUser[] {
  const users: B2BUser[] = [];
  const admin = process.env.B2B_PASSWORD;
  if (admin) users.push({ name: "관리자", password: admin });

  const raw = process.env.B2B_USERS || "";
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const password = part.slice(idx + 1).trim();
    if (name && password) users.push({ name, password });
  }
  return users;
}

// 쿠키 토큰(=비밀번호, 구버전) → 사용자 이름. 일치 없으면 null.
export function resolveUserName(token: string | undefined | null): string | null {
  if (!token) return null;
  const u = getB2BUsers().find((x) => x.password === token);
  return u ? u.name : null;
}

// 관리자 권한 이름(설정·계정관리 접근)
const ADMINS = new Set(["관리자", "현석"]);
export function isAdminName(name: string | null | undefined): boolean {
  return !!name && ADMINS.has(name);
}

// ── 서명 세션 토큰 ──────────────────────────────────────────────
// DB 계정은 비밀번호가 환경변수에 없으므로, 로그인 시 이름을 서명한 토큰을 발급하고
// 미들웨어는 서명만 검증한다(매 요청 DB 조회 회피). 시크릿 = B2B_PASSWORD(서버 전용).
// crypto.subtle·btoa·TextEncoder 만 사용 → Edge 미들웨어 호환.
const enc = new TextEncoder();
function authSecret(): string {
  return process.env.B2B_PASSWORD || process.env.B2B_USERS || "sm-internal-fallback";
}
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(authSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return b64url(sig);
}
// 토큰: "<urlencoded name>.<hmac(name)>"
export async function signSession(name: string): Promise<string> {
  return `${encodeURIComponent(name)}.${await hmac(name)}`;
}
export async function verifySession(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  let name: string;
  try { name = decodeURIComponent(token.slice(0, i)); } catch { return null; }
  const sig = token.slice(i + 1);
  const expect = await hmac(name);
  if (sig.length !== expect.length) return null;
  let diff = 0;
  for (let k = 0; k < sig.length; k++) diff |= sig.charCodeAt(k) ^ expect.charCodeAt(k);
  return diff === 0 ? name : null;
}
