// 급여·연차 창(/hr) 인증 — 업무도우미 로그인(b2b-auth.ts)과 완전히 따로 돈다.
//
//  대표(2026-11-20): "지정한 비번만 들어갈 수 있어야 한다. 오류조차 허용하지 않도록 창 자체를 별도로."
//  그래서 쿠키·서명 키·계정 목록이 전부 다르다. 업무도우미 쪽 인증 코드를 어떻게 고쳐도 이 창은 열리지 않는다.
//
//  환경변수(둘 다 없으면 누구도 못 들어온다 — 기본값·대체값 없음):
//    HR_SECRET   세션 서명 키. 16자 이상. B2B_PASSWORD 와 다른 값.
//    HR_USERS    "이름:비밀번호,이름:비밀번호". 비밀번호 8자 이상. 화면에서 계정을 만드는 기능은 없다.
//
//  middleware(Edge)와 라우트 핸들러 양쪽에서 import — Node 전용 API 사용 금지.

export const HR_COOKIE = "hr_auth";
export const HR_TTL_S = 12 * 3600; // 12시간 뒤 만료. 자동 연장 없음(업무도우미의 30일 슬라이딩과 다르다)
const MIN_PASSWORD = 8;
const MIN_SECRET = 16;

export type HrUser = { name: string; password: string };

export function getHrUsers(): HrUser[] {
  const out: HrUser[] = [];
  for (const part of (process.env.HR_USERS || "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const password = part.slice(i + 1).trim();
    if (!name || password.length < MIN_PASSWORD) continue; // 짧은 비밀번호는 없는 것으로 친다
    if (out.some((u) => u.name === name || u.password === password)) continue; // 이름·비밀번호는 서로 달라야 한다
    out.push({ name, password });
  }
  return out;
}

function secret(): string | null {
  const s = process.env.HR_SECRET || "";
  return s.length >= MIN_SECRET ? s : null;
}

// 설정이 갖춰졌는가 — 아니면 로그인 화면이 "설정 전"이라고만 답한다
export function hrConfigured(): boolean {
  return !!secret() && getHrUsers().length > 0;
}

const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))));
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 토큰: "<urlencoded payload>.<hmac>", payload = "hr1|이름|<만료 epoch 초>"
//  머리의 hr1 은 업무도우미 토큰("이름|역할|x만료")과 모양부터 다르게 하려는 표지다.
export async function signHrSession(name: string): Promise<string> {
  const key = secret();
  if (!key) throw new Error("HR_SECRET 이 설정되어 있지 않습니다.");
  const exp = Math.floor(Date.now() / 1000) + HR_TTL_S;
  const payload = `hr1|${name}|${exp}`;
  return `${encodeURIComponent(payload)}.${await hmac(key, payload)}`;
}

// 서명·만료를 확인하고, 그 이름이 지금도 HR_USERS 에 있는지 본다 —
//  환경변수에서 사람을 빼고 다시 배포하면 그 사람의 세션은 그 순간 끊긴다.
export async function verifyHrSession(token: string | undefined | null): Promise<string | null> {
  const key = secret();
  if (!key || !token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  let payload: string;
  try { payload = decodeURIComponent(token.slice(0, i)); } catch { return null; }
  if (!sameText(token.slice(i + 1), await hmac(key, payload))) return null;
  const parts = payload.split("|");
  if (parts.length < 3 || parts[0] !== "hr1") return null;
  const exp = Number(parts[parts.length - 1]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const name = parts.slice(1, -1).join("|");
  return getHrUsers().some((u) => u.name === name) ? name : null;
}

// 급여 창 구역인가(화면·API). 미들웨어와 셸이 같은 판정을 쓴다.
export function isHrPath(p: string): boolean {
  return p === "/hr" || p.startsWith("/hr/") || p === "/api/hr" || p.startsWith("/api/hr/");
}
