import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getB2BUsers, isAdminName, resolveUserName, verifySessionFull } from "@/app/lib/b2b-auth";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30일

// 파도소리(제조사) 계정에 열어줄 경로. 로그인·로그아웃은 열려 있어야 로그인 자체가 된다.
function isFactoryPath(p: string): boolean {
  return p === "/factory" || p.startsWith("/factory/") || p.startsWith("/api/factory")
    || p === "/b2b/login" || p === "/api/b2b/auth";
}

// /b2b 와 /api/b2b 전체를 비밀번호로 보호.
// 사용자별 비밀번호(B2B_USERS) + 관리자 비밀번호(B2B_PASSWORD) — 비밀번호로 사용자를 구분.
// 쿠키 b2b_auth 값(비밀번호)을 직접 비교 (HttpOnly+Secure 라 노출 위험 낮음).
// 비번 변경 시 해당 사용자는 다시 로그인 필요 — 사내 도구라 의도된 동작.

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 브랜드링크/QR 전용 호스트(link.seamonster.kr): 루트의 단일 경로를 숏링크로 매핑 → /캠페인명 을 /q/캠페인명 으로 내부 리라이트.
  //  기본값 link.seamonster.kr, SHORT_LINK_HOST 환경변수로 재정의 가능. 관리툴 도메인은 host 가 달라 이 블록을 타지 않음.
  const host = (req.headers.get("host") || "").toLowerCase();

  const shortHost = (process.env.SHORT_LINK_HOST || "link.seamonster.kr").toLowerCase();
  if (shortHost && host === shortHost) {
    if (pathname.startsWith("/q/")) return NextResponse.next();       // 이미 정규 경로(공개)
    if (/^\/[^/]+$/.test(pathname)) {                                  // 단일 세그먼트 = 숏코드
      const url = req.nextUrl.clone();
      url.pathname = `/q${pathname}`;                                 // /여름세일 → /q/여름세일
      return NextResponse.rewrite(url);
    }
    return new NextResponse(
      "<!doctype html><meta charset=\"utf-8\"><title>QR</title><body style=\"font-family:system-ui;text-align:center;padding:60px;color:#555\">QR 단축링크 전용 도메인입니다.</body>",
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // 파도소리 전용 도메인(선택). FACTORY_HOST 를 설정하면 그 호스트는 /factory 만 서비스한다.
  //  모르는 호스트(베타 배포 URL·localhost)는 내부로 취급한다 — 접근 통제는 아래 역할 검사가 담당하고
  //  이 분기는 주소 안내와 1차 필터다. 도메인을 붙이기 전에는 FACTORY_HOST 를 비워두면 된다.
  const factoryHost = (process.env.FACTORY_HOST || "").toLowerCase();
  if (factoryHost && host === factoryHost && !isFactoryPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/factory";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 로그인 페이지·로그인 API + QR 숏링크(/q/*) + 아침 다이제스트 크론·아침 브리핑 크론·은행입금 동기화 크론·입금문자 웹훅 + 인스타 댓글 웹훅·Tally 설문 웹훅(서명 검증) — 자체 검증이 있어 보호 제외
  if (pathname === "/b2b/login" || pathname === "/factory/login" || pathname === "/api/b2b/auth" || pathname === "/api/voc/tally" || pathname === "/api/b2b/schedule-digest" || pathname === "/api/briefing/cron" || pathname === "/api/b2b/deposits/webhook" || pathname === "/api/instagram/webhook" || pathname.startsWith("/q/")) {
    return NextResponse.next();
  }

  // API 는 인증 실패 시 JSON 401, 페이지는 로그인으로 리다이렉트
  const isApi = pathname.startsWith("/api/");

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

  // 서명 세션 토큰(신버전, DB 계정 포함) 또는 구버전 비밀번호 쿠키(환경변수 계정) 둘 다 허용
  const token = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(token);
  const authed = sess?.name || resolveUserName(token); // 구버전 쿠키 = 환경변수 계정 = internal
  if (token && authed) {
    // 파도소리 계정은 /factory 밖으로 나가지 못한다. 메뉴 숨김이 아니라 경로 차단이라
    // API 를 직접 불러도 막힌다(사이드바에서 안 보이는 것과 다르다).
    if (sess?.role === "factory" && !isFactoryPath(pathname)) {
      if (isApi) return NextResponse.json({ ok: false, error: "접근 권한이 없습니다." }, { status: 403 });
      const url = req.nextUrl.clone();
      url.pathname = "/factory";
      url.search = "";
      return NextResponse.redirect(url);
    }
    // 반대 방향도 막는다: 파도소리 구역(/factory·/api/factory)은 파도소리 계정과 관리자만.
    //  일반 내부 계정은 화면·API 모두 차단(제조사 데이터 분리 — 2026-08-06 결정).
    //  (/factory/login 은 위 공개 예외라 여기 도달하지 않는다)
    const factoryArea = pathname === "/factory" || pathname.startsWith("/factory/") || pathname.startsWith("/api/factory");
    if (sess?.role !== "factory" && factoryArea && !isAdminName(authed)) {
      if (isApi) return NextResponse.json({ ok: false, error: "파도소리 계정 전용입니다." }, { status: 403 });
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
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

  // 파도소리 화면(/factory·전용 호스트)은 파도소리 로그인으로 — 씨몬스터 로그인 화면을 보여주지 않는다.
  const url = req.nextUrl.clone();
  const toFactory = pathname.startsWith("/factory") || (!!factoryHost && host === factoryHost);
  url.pathname = toFactory ? "/factory/login" : "/b2b/login";
  url.search = "";
  if (toFactory) {
    if (pathname !== "/factory") url.searchParams.set("redirect", pathname + (req.nextUrl.search || ""));
  } else if (pathname !== "/b2b") {
    url.searchParams.set("redirect", pathname + (req.nextUrl.search || ""));
  }
  return NextResponse.redirect(url);
}

export const config = {
  // 전체 게이팅: Next 내부·정적 이미지/폰트/스타일만 공개, 나머지(페이지·API·iframe html)는 로그인 필수.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)).*)"],
};
