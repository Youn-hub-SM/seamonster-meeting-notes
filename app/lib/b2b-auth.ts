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

// 계정 역할(migration 088). internal = 내부 계정(전 메뉴) / factory = 파도소리 계정(/factory 만).
//  환경변수 계정(B2B_PASSWORD·B2B_USERS)은 항상 internal — 외부 계정은 DB(app_users)로만 만든다.
export const APP_ROLES = ["internal", "factory"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export type Session = { name: string; role: AppRole };

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
// 토큰: "<urlencoded payload>.<hmac(payload)>"
//  payload = 이름(internal) 또는 "이름|역할"(그 외). internal 은 이름만 실어 **구버전 토큰과 같은 값**이 되므로
//  이미 발급된 쿠키가 그대로 유효하다(역할 도입으로 전원 로그아웃되지 않는다).
export async function signSession(name: string, role: AppRole = "internal"): Promise<string> {
  const payload = role === "internal" ? name : `${name}|${role}`;
  return `${encodeURIComponent(payload)}.${await hmac(payload)}`;
}

// 서명 검증 후 이름·역할까지. 미들웨어처럼 역할이 필요한 곳에서 쓴다.
export async function verifySessionFull(token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  let payload: string;
  try { payload = decodeURIComponent(token.slice(0, i)); } catch { return null; }
  const sig = token.slice(i + 1);
  const expect = await hmac(payload);
  if (sig.length !== expect.length) return null;
  let diff = 0;
  for (let k = 0; k < sig.length; k++) diff |= sig.charCodeAt(k) ^ expect.charCodeAt(k);
  if (diff !== 0) return null;

  // 역할 분리는 '알려진 역할 이름'일 때만 — 이름에 '|' 가 들어가도 오인하지 않는다.
  const bar = payload.lastIndexOf("|");
  if (bar > 0) {
    const tail = payload.slice(bar + 1);
    if ((APP_ROLES as readonly string[]).includes(tail)) return { name: payload.slice(0, bar), role: tail as AppRole };
  }
  return { name: payload, role: "internal" };
}

// 기존 호출부(18곳) 호환 — 이름만 돌려준다.
export async function verifySession(token: string | undefined | null): Promise<string | null> {
  return (await verifySessionFull(token))?.name ?? null;
}
