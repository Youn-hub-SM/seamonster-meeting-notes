import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { listThreads, createThread, isPending139, PENDING_139 } from "@/app/lib/chat-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 비서 대화 스레드(2026-10-19 대화형). GET ?all=1(관리자) 목록 / POST 새 스레드.
async function who(req: NextRequest): Promise<string> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token) || "?";
}
const pending = () => NextResponse.json({ ok: false, error: PENDING_139, pending_migration: true }, { status: 503 });

export async function GET(req: NextRequest) {
  try {
    const user = await who(req);
    const threads = await listThreads(user, req.nextUrl.searchParams.get("all") === "1");
    return NextResponse.json({ ok: true, threads });
  } catch (e) {
    if (isPending139(e)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "대화 목록을 불러오지 못했습니다.") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await who(req);
    const thread = await createThread(user);
    return NextResponse.json({ ok: true, thread });
  } catch (e) {
    if (isPending139(e)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "새 대화를 만들지 못했습니다.") }, { status: 500 });
  }
}
