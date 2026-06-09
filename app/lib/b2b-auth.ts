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

// 쿠키 토큰(=비밀번호) → 사용자 이름. 일치 없으면 null.
export function resolveUserName(token: string | undefined | null): string | null {
  if (!token) return null;
  const u = getB2BUsers().find((x) => x.password === token);
  return u ? u.name : null;
}
