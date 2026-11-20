import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getB2BUsers, isAdminName, resolveUserName, signSession, verifySessionFull } from "@/app/lib/b2b-auth";
import { HR_COOKIE, isHrPath, verifyHrSession } from "@/app/lib/hr-auth";

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

  // 파도소리 전용 도메인(pdsr.kr, 2026-10-20). FACTORY_HOST 를 설정하면 그 호스트는 /factory 만 서비스한다.
  //  쉼표로 여러 개("pdsr.kr,www.pdsr.kr"). 모르는 호스트(베타 배포 URL·localhost)는 내부로 취급한다 —
  //  접근 통제는 아래 역할 검사가 담당하고 이 분기는 주소 안내와 1차 필터다.
  //  대표 규칙: 파도소리 주소에서는 씨몬스터 업무도우미가 전혀 보이면 안 된다 → 씨몬스터 로그인(/b2b/login)도 막고
  //  파도소리 로그인으로 보낸다(로그인 API /api/b2b/auth 는 파도소리 로그인 화면이 쓰므로 연다).
  const factoryHosts = (process.env.FACTORY_HOST || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const onFactoryHost = factoryHosts.includes(host);
  if (onFactoryHost && (pathname === "/b2b/login" || !isFactoryPath(pathname))) {
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/b2b/login" ? "/factory/login" : "/factory";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 급여·연차 창(/hr·/api/hr, 2026-11-20). 업무도우미 로그인과 완전히 따로 잠근다 —
  //  여기서 끝내고 아래 b2b_auth 판정으로 내려가지 않는다. 업무도우미 관리자·파도소리 계정이어도 hr_auth 쿠키가 없으면 못 들어온다.
  //  (반대로 hr_auth 만 가진 사람은 아래에서 b2b_auth 가 없어 업무도우미 로그인으로 간다)
  //  각 /api/hr 경로도 스스로 한 번 더 검증한다(app/lib/hr-db.ts requireHr) — 이 분기가 실수로 빠져도 열리지 않게.
  if (isHrPath(pathname)) {
    const noStore = (res: NextResponse) => {
      res.headers.set("Cache-Control", "no-store");
      res.headers.set("X-Robots-Tag", "noindex, nofollow");
      return res;
    };
    // 로그인 화면이 쓰는 아이콘 두 개는 연다(아래 matcher 가 /hr 아래는 확장자와 상관없이 전부 이 분기로 보낸다)
    if (pathname === "/hr/icon.png" || pathname === "/hr/apple-icon.png") return NextResponse.next();
    if (pathname === "/hr/login" || pathname === "/api/hr/auth") return noStore(NextResponse.next());
    const who = await verifyHrSession(req.cookies.get(HR_COOKIE)?.value);
    if (who) return noStore(NextResponse.next());
    if (pathname.startsWith("/api/")) {
      return noStore(NextResponse.json({ ok: false, error: "인증이 필요합니다." }, { status: 401 }));
    }
    const url = req.nextUrl.clone();
    url.pathname = "/hr/login";
    url.search = "";
    if (pathname !== "/hr") url.searchParams.set("redirect", pathname + (req.nextUrl.search || ""));
    return noStore(NextResponse.redirect(url));
  }

  // 로그인 페이지·로그인 API + QR 숏링크(/q/*) + 아침 다이제스트 크론·일일 리포트 크론·은행입금 동기화 크론·입금문자 웹훅·신청자 문자 예약 신호(/api/form-sms/tick)·인증번호 문자 웹훅(/api/sms/otp) + 인스타 댓글 웹훅·Tally 설문 웹훅(서명 검증) + GA MCP 서버(/api/mcp/*, Bearer MCP_API_KEY) — 자체 검증이 있어 보호 제외
  if (pathname === "/b2b/login" || pathname === "/factory/login" || pathname === "/api/b2b/auth" || pathname === "/api/voc/tally" || pathname === "/api/b2b/schedule-digest" || pathname === "/api/analyst/cron" || pathname === "/api/agents/tick" || pathname === "/api/form-sms/tick" || pathname === "/api/b2b/deposits/webhook" || pathname === "/api/sms/otp" || pathname === "/api/instagram/webhook" || pathname === "/api/naver/catalog/sync" || pathname === "/api/naver/catalog/upload" || pathname === "/api/channel-commands" || pathname === "/api/detail/applies" || pathname === "/api/detail/sources" || pathname === "/api/detail/sets" || pathname === "/api/claims/report" || pathname === "/api/subscription/sync" || pathname.startsWith("/api/mcp/") || pathname.startsWith("/q/")) {
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
    //  토큰 자체 만료(v2, 30일)가 절반 이하로 남으면 재서명 — 활동 중엔 유지, 방치·회수 대상은 30일 내 만료.
    let cookieToken = token;
    if (sess?.exp && sess.exp * 1000 - Date.now() < 15 * 86400 * 1000) {
      try { cookieToken = await signSession(sess.name, sess.role); } catch { /* 재서명 실패 — 기존 토큰 유지 */ }
    }
    const res = NextResponse.next();
    res.cookies.set("b2b_auth", cookieToken, {
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
  const toFactory = pathname.startsWith("/factory") || onFactoryHost;
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
  // 2026-10-28 호출 감축: 자체 검증이 있어 위에서 그냥 통과시키던 경로(웹훅·크론·채널 명령·MCP·QR)와 txt·xml·json 파일은(public 의 html 2개는 로그인 보호를 유지)
  //  matcher 에서 아예 빼 미들웨어가 실행되지 않게 한다 — 미들웨어 실행도 Vercel 호출 한도(100만)에 함께 센다(10월 61%).
  //  link.seamonster.kr/코드 리라이트는 단일 세그먼트 경로라 여전히 matcher 에 남는다. docs/vercel-invocation-plan.md
  // 2026-11-20 확장자 구멍 막음: 맨 끝의 확장자 제외는 /api/·/b2b/ 아래에는 적용하지 않는다(그 대안 앞의 (?!api/|b2b/)).
  //  마지막 칸이 동적인 경로(/api/b2b/orders/[id]·/b2b/orders/[id] 등)는 '아무값.json'·'아무값.png' 로도 닿아, 로그인 검사 없이 핸들러·화면이 실행됐다.
  //  /api·/b2b 아래에는 정적 파일이 없다. 이름으로 뺀 웹훅·크론·MCP 경로는 앞쪽 대안에 먼저 걸려 그대로 미들웨어를 타지 않는다.
  //  마지막 칸이 동적인 화면을 다른 구역에 새로 만들면 그 구역 접두사를 여기에 더한다(로그인 화면 아이콘이 있는 /factory 는 통째로 넣지 않는다).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|q/|api/mcp/|api/channel-commands(?:/|$)|api/detail/applies(?:/|$)|api/detail/sources(?:/|$)|api/detail/sets(?:/|$)|api/b2b/schedule-digest(?:/|$)|api/analyst/cron(?:/|$)|api/agents/tick(?:/|$)|api/form-sms/tick(?:/|$)|api/b2b/deposits/webhook(?:/|$)|api/sms/otp(?:/|$)|api/instagram/webhook(?:/|$)|api/voc/tally$|api/naver/catalog/(?:sync|upload)(?:/|$)|api/claims/report(?:/|$)|api/subscription/sync(?:/|$)|(?!api/|b2b/).*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map|txt|xml|json|webmanifest)$).*)",
    // 급여·연차 창은 확장자 제외를 적용하지 않는다(2026-11-20). 위 패턴은 .json·.png 로 끝나는 주소에서 미들웨어를 건너뛰는데,
    //  동적 경로(/api/hr/employees/[id])는 '아무값.json' 으로도 닿는다 — /hr·/api/hr 아래는 무엇으로 끝나든 반드시 위 hr 분기를 탄다.
    "/hr/:path*", "/api/hr/:path*",
  ],
};
