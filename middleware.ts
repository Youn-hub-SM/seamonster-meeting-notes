import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// /b2b 와 /api/b2b 전체를 단일 비밀번호로 보호.
// 비번은 환경변수 B2B_PASSWORD 에 평문 저장.
// 쿠키 b2b_auth 값을 환경변수와 직접 비교 (HttpOnly+Secure 라 노출 위험 낮음).
// 비번 변경 시 모든 사용자가 다시 로그인 필요 — 사내 도구라 의도된 동작.

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 로그인 페이지·로그인 API 는 보호 제외 (그래야 들어올 수 있음)
  if (pathname === "/b2b/login" || pathname === "/api/b2b/auth") {
    return NextResponse.next();
  }

  const expected = process.env.B2B_PASSWORD;
  if (!expected) {
    // 환경변수 미설정 — 보안상 모든 접근 차단
    if (pathname.startsWith("/api/b2b/")) {
      return NextResponse.json(
        { ok: false, error: "B2B_PASSWORD 환경변수가 서버에 설정되어 있지 않습니다." },
        { status: 503 }
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/b2b/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  const token = req.cookies.get("b2b_auth")?.value;
  if (token && token === expected) {
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
