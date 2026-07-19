import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getSavedMarginCalcs, addSavedMarginCalc, deleteSavedMarginCalc } from "@/app/lib/margin-saved";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → 저장된 계산 목록
export async function GET() {
  try {
    return NextResponse.json({ ok: true, saved: await getSavedMarginCalcs() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "목록 조회 실패") }, { status: 500 });
  }
}

// POST { name, question } → 저장
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { name?: string; question?: string };
    const name = (b.name || "").trim();
    const question = (b.question || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "이름을 입력하세요." }, { status: 400 });
    if (!question) return NextResponse.json({ ok: false, error: "질문이 비어 있습니다." }, { status: 400 });
    const token = req.cookies.get("b2b_auth")?.value;
    const createdBy = (await verifySession(token)) || resolveUserName(token);
    const rec = await addSavedMarginCalc({ name, question, createdBy });
    return NextResponse.json({ ok: true, saved: rec });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}

// DELETE ?id= → 삭제
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    await deleteSavedMarginCalc(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "삭제 실패") }, { status: 500 });
  }
}
