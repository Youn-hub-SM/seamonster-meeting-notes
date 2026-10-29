import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { requestStop } from "@/app/lib/chat-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST — 진행 중인 턴에 중지 요청(2026-10-29). 턴은 화면 연결과 무관하게 서버에서 끝까지 돌므로,
//  [중지]는 연결 끊기가 아니라 이 표식으로 전한다(send 라우트가 3초마다 보고 모델 호출을 끊는다). 비로그인은 미들웨어가 막는다.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "대화 번호가 올바르지 않습니다." }, { status: 400 });
    await requestStop(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "중지 요청을 저장하지 못했습니다.") }, { status: 500 });
  }
}
