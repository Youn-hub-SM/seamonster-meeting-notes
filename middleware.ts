import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getB2BUsers } from "@/app/lib/b2b-auth";

// /b2b 와 /api/b2b 전체를 비밀번호로 보호.
// 사용자별 비밀번호(B2B_USERS) + 관리자 비밀번호(B2B_PASSWORD) — 비밀번호로 사용자를 구분.
// 쿠키 b2b_auth 값(비밀번호)을 직접 비교 (HttpOnly+Secure 라 노출 위험 낮음).
// 비번 변경 시 해당 사용자는 다시 로그인 필요 — 사내 도구라 의도된 동작.

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 로그인 페이지·로그인 API 는 보호 제외 (그래야 들어올 수 있음)
  if (pathname === "/b2b/login" || pathname === "/api/b2b/auth") {
    return NextResponse.next();
  }

  const users = getB2BUsers();
  if (users.length === 0) {
    // 환경변수 미설정 — 보안상 모든 접근 차단
    if (pathname.startsWith("/api/b2b/")) {
      return NextResponse.json(
        { ok: false, error: "B2B_PASSWORD/B2B_USERS 환경변수가 서버에 설정되어 있지 않습니다." },
        { status: 503 }
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/b2b/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  const token = req.cookies.get("b2b_auth")?.value;
  if (token && users.some((u) => u.password === token)) {
    return NextResponse.next();
  }

  // 인증 실패
  if (pathname.startsWith("/api/b2b/")) {
    return NextResponse.json({ ok: false, error: "인증이 필요합니다." }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/b2b/login";
  if (pathname !== "/b2b") url.searchParams.set("redirect", pathname + (req.nextUrl.search || ""));
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/b2b/:path*", "/api/b2b/:path*"],
};
