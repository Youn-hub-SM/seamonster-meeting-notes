import { NextRequest, NextResponse } from "next/server";
import { getB2BUsers, resolveUserName } from "@/app/lib/b2b-auth";

export const dynamic = "force-dynamic";

const COOKIE = "b2b_auth";
const MAX_AGE = 60 * 60 * 24 * 30; // 30일

// POST: 비번 검증 후 쿠키 발급 — 비밀번호로 사용자(지인/예지/현석/관리자) 식별
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: string };
    const password = body.password ?? "";
    const users = getB2BUsers();
    if (users.length === 0) {
      return NextResponse.json(
        { ok: false, error: "서버에 B2B_PASSWORD/B2B_USERS 가 설정되어 있지 않습니다." },
        { status: 503 }
      );
    }
    const user = users.find((u) => u.password === password);
    if (!user) {
      return NextResponse.json({ ok: false, error: "비밀번호가 틀렸습니다." }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true, name: user.name });
    res.cookies.set(COOKIE, password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: MAX_AGE,
    });
    return res;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "로그인 실패" },
      { status: 500 }
    );
  }
}

// GET: 현재 로그인한 사용자 이름 (헤더 표시용)
export async function GET(req: NextRequest) {
  const name = resolveUserName(req.cookies.get(COOKIE)?.value);
  if (!name) {
    return NextResponse.json({ ok: false, error: "인증이 필요합니다." }, { status: 401 });
  }
  return NextResponse.json({ ok: true, name });
}

// DELETE: 로그아웃 (쿠키 제거)
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
