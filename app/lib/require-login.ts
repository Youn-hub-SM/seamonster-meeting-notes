import { NextRequest, NextResponse } from "next/server";
import { getB2BUsers, isAdminName, resolveUserName, verifySessionFull, type AppRole } from "@/app/lib/b2b-auth";

// 핸들러 자체 로그인 검증(2026-11-21). 미들웨어가 이미 막지만 여기서 한 번 더 본다(이중 검사, 급여 창 requireHr 와 같은 뜻).
//  미들웨어 matcher 가 건너뛴 주소에서는 핸들러가 로그인 없이 돈다 — 2026-11-20 확장자 구멍('/api/…/[id]' 가 '아무값.json' 으로 닿음).
//  마지막 칸이 동적인 API 핸들러의 첫 줄에 둔다:
//    const login = await requireLogin(req);            // 업무도우미(내부 계정)
//    const login = await requireLogin(req, "factory"); // /api/factory — 파도소리 계정과 관리자만
//    if (login.res) return login.res;
//  판정은 middleware.ts 와 같아야 한다 — 더 엄하면 정상 요청이 막히고, 더 느슨하면 겹으로 두는 뜻이 없다.
//  미들웨어의 로그인·역할 규칙을 바꾸면 여기도 같이 바꾼다.
type Ok = { name: string; role: AppRole; admin: boolean; res?: undefined };
type No = { name?: undefined; role?: undefined; admin?: undefined; res: NextResponse };
const deny = (error: string, status: number): No => ({ res: NextResponse.json({ ok: false, error }, { status }) });

export async function requireLogin(req: NextRequest, area: "internal" | "factory" = "internal"): Promise<Ok | No> {
  // 계정 환경변수가 없으면 서명 키가 기본값으로 떨어진다 — 미들웨어처럼 전부 막는다
  if (getB2BUsers().length === 0) return deny("B2B_PASSWORD/B2B_USERS 환경변수가 서버에 설정되어 있지 않습니다.", 503);
  const token = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(token);
  const name = sess?.name || resolveUserName(token); // 옛 비밀번호 쿠키 = 환경변수 계정 = internal
  if (!token || !name) return deny("인증이 필요합니다.", 401);
  const role: AppRole = sess?.role ?? "internal";
  const admin = isAdminName(name);
  if (area === "factory") {
    if (role !== "factory" && !admin) return deny("파도소리 계정 전용입니다.", 403);
  } else if (role === "factory") {
    return deny("접근 권한이 없습니다.", 403);
  }
  return { name, role, admin };
}
