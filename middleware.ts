import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getB2BUsers } from "@/app/lib/b2b-auth";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30일

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

  // B2B·생산관리 API 는 인증 실패 시 JSON 401, 페이지는 로그인으로 리다이렉트
  const isApi = pathname.startsWith("/api/b2b/") || pathname.startsWith("/api/production/");

  const users = getB2BUsers();
  if (users.length === 0) {
    // 환경변수 미설정 — 보안상 모든 접근 차단
    if (isApi) {
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
    // 슬라이딩 세션: 인증된 요청마다 쿠키 만료를 30일 뒤로 재발급.
    // iOS 사파리(ITP)는 쿠키 지속 정책이 빡빡해 고정 만료면 쉽게 풀림 —
    // 방문(페이지 이동)·API 호출마다 다시 발급해 계속 쓰는 동안 안 풀리게 함.
    const res = NextResponse.next();
    res.cookies.set("b2b_auth", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
      expires: new Date(Date.now() + COOKIE_MAX_AGE * 1000),
    });
    return res;
  }

  // 인증 실패
  if (isApi) {
    return NextResponse.json({ ok: false, error: "인증이 필요합니다." }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/b2b/login";
  if (pathname !== "/b2b") url.searchParams.set("redirect", pathname + (req.nextUrl.search || ""));
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/b2b/:path*", "/api/b2b/:path*", "/production/:path*", "/api/production/:path*"],
};
