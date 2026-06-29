import { NextRequest, NextResponse } from "next/server";
import { getB2BUsers, resolveUserName, signSession, verifySession } from "@/app/lib/b2b-auth";
import { getActiveDbUsers } from "@/app/lib/app-users";

export const dynamic = "force-dynamic";

const COOKIE = "b2b_auth";
const MAX_AGE = 60 * 60 * 24 * 30; // 30일

// POST: 비번 검증(환경변수 계정 + DB 계정) 후 서명 토큰 쿠키 발급
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: string };
    const password = (body.password ?? "").trim();
    const envUsers = getB2BUsers();
    if (envUsers.length === 0) {
      return NextResponse.json({ ok: false, error: "서버에 B2B_PASSWORD 가 설정되어 있지 않습니다." }, { status: 503 });
    }
    let name = envUsers.find((u) => u.password === password)?.name || null;
    if (!name && password) {
      const dbUsers = await getActiveDbUsers();
      name = dbUsers.find((u) => u.password === password)?.name || null;
    }
    if (!name) {
      return NextResponse.json({ ok: false, error: "비밀번호가 틀렸습니다." }, { status: 401 });
    }
    const token = await signSession(name);
    const res = NextResponse.json({ ok: true, name });
    res.cookies.set(COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: MAX_AGE,
      expires: new Date(Date.now() + MAX_AGE * 1000),
    });
    return res;
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "로그인 실패" }, { status: 500 });
  }
}

// GET: 현재 로그인 사용자 이름 (서명 토큰 우선, 구버전 비밀번호 쿠키 호환)
export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE)?.value;
  const name = (await verifySession(token)) || resolveUserName(token);
  if (!name) {
    return NextResponse.json({ ok: false, error: "인증이 필요합니다." }, { status: 401 });
  }
  return NextResponse.json({ ok: true, name });
}

// DELETE: 로그아웃
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
