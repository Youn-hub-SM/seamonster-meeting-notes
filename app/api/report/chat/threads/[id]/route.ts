import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadThreadItems, archiveThread, isPending139, PENDING_139 } from "@/app/lib/chat-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 스레드 1건(화면 항목: 사용자 글·비서 글·도구 칩+표) / DELETE 보관(archived — 목록에서 빠지고 데이터는 남는다)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function who(req: NextRequest): Promise<string> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token) || "?";
}
const pending = () => NextResponse.json({ ok: false, error: PENDING_139, pending_migration: true }, { status: 503 });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "대화 번호가 올바르지 않습니다." }, { status: 400 });
    const r = await loadThreadItems(id, await who(req));
    if (!r) return NextResponse.json({ ok: false, error: "대화를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (isPending139(e)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "대화를 불러오지 못했습니다.") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "대화 번호가 올바르지 않습니다." }, { status: 400 });
    const ok = await archiveThread(id, await who(req));
    if (!ok) return NextResponse.json({ ok: false, error: "대화를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isPending139(e)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "대화를 지우지 못했습니다.") }, { status: 500 });
  }
}
