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
export type Session = { name: string; role: AppRole; exp?: number }; // exp = 만료(epoch 초, v2 토큰)

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
// 토큰(v2): "<urlencoded payload>.<hmac(payload)>", payload = "이름|역할|x<만료 epoch 초>"
//  만료 도입(2026-09-11 감사 후속) — 종전 v1 토큰은 만료가 없어 계정 삭제·비밀번호 변경으로도
//  회수가 불가능했다(값을 보관하면 영구 유효). v1 은 더 이상 통과시키지 않으므로 배포 시
//  전원 1회 재로그인이 발생한다(의도된 컷오버). 활동 중엔 미들웨어가 재서명해 계속 유지된다.
const SESSION_TTL_S = 30 * 86400; // 30일
export async function signSession(name: string, role: AppRole = "internal"): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = `${name}|${role}|x${exp}`;
  return `${encodeURIComponent(payload)}.${await hmac(payload)}`;
}

// 서명 검증 후 이름·역할·만료까지. 미들웨어처럼 역할이 필요한 곳에서 쓴다.
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

  // v2 형식만 인정: "...|역할|x<exp>". 이름에 '|' 가 들어가도 뒤 두 세그먼트로만 판정한다.
  const parts = payload.split("|");
  const tail = parts[parts.length - 1] || "";
  if (parts.length >= 3 && /^x\d{5,}$/.test(tail)) {
    const exp = Number(tail.slice(1));
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null; // 만료
    const roleSeg = parts[parts.length - 2];
    if ((APP_ROLES as readonly string[]).includes(roleSeg)) {
      return { name: parts.slice(0, -2).join("|"), role: roleSeg as AppRole, exp };
    }
  }
  return null; // v1(무만료)·형식 불량 — 재로그인 필요
}

// 기존 호출부(18곳) 호환 — 이름만 돌려준다.
export async function verifySession(token: string | undefined | null): Promise<string | null> {
  return (await verifySessionFull(token))?.name ?? null;
}
