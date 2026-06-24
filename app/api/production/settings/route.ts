import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getBoxheroToken, setBoxheroToken, testBoxheroToken, maskToken } from "@/app/lib/boxhero";

export const dynamic = "force-dynamic";

// GET — 박스히어로 토큰 설정 상태(마스킹만, 원문 비노출)
export async function GET() {
  try {
    const token = await getBoxheroToken();
    return NextResponse.json({ ok: true, configured: !!token, masked: maskToken(token) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { token } — 토큰 저장 + 연결 테스트
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { token?: string };
    const token = (body.token || "").trim();
    if (!token) {
      return NextResponse.json({ ok: false, error: "토큰을 입력하세요." }, { status: 400 });
    }
    // 먼저 유효성 확인 후 저장 (잘못된 토큰 저장 방지)
    const test = await testBoxheroToken(token);
    if (!test.ok) {
      return NextResponse.json({ ok: false, error: `박스히어로 연결 실패 — ${test.error}` }, { status: 400 });
    }
    await setBoxheroToken(token);
    return NextResponse.json({ ok: true, masked: maskToken(token) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
