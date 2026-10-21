import { NextResponse, type NextRequest } from "next/server";
import { verifySession, resolveUserName, isAdminName } from "./b2b-auth";

// 관리자 › 설정의 저장 API 공용 관리자 확인(2026-10-21 설정 통합). 화면 메뉴만 숨기면 로그인한 누구나 저장할 수 있었다.
//  쓰는 법: const deny = await adminOnly(req); if (deny) return deny;
export async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return isAdminName(name);
}

export async function adminOnly(req: NextRequest): Promise<NextResponse | null> {
  return (await isAdminReq(req)) ? null : NextResponse.json({ ok: false, error: "관리자만 바꿀 수 있습니다." }, { status: 403 });
}
