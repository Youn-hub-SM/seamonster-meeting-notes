import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE = "b2b_auth";
const MAX_AGE = 60 * 60 * 24 * 30; // 30일

// POST: 비번 검증 후 쿠키 발급
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: string };
    const password = body.password ?? "";
    const expected = process.env.B2B_PASSWORD;
    if (!expected) {
      return NextResponse.json(
        { ok: false, error: "서버에 B2B_PASSWORD 가 설정되어 있지 않습니다." },
        { status: 503 }
      );
    }
    if (password !== expected) {
      return NextResponse.json({ ok: false, error: "비밀번호가 틀렸습니다." }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
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
