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

// POST { name, question, result? } → 저장 (result = 저장 시점 결과 스냅샷, 즉시 열기용)
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { name?: string; question?: string; result?: unknown };
    const name = (b.name || "").trim();
    const question = (b.question || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "이름을 입력하세요." }, { status: 400 });
    if (!question) return NextResponse.json({ ok: false, error: "질문이 비어 있습니다." }, { status: 400 });
    // 스냅샷 크기 상한 — KV 리스트가 비대해지지 않게(넘으면 스냅샷만 생략, 저장은 진행)
    const result = b.result && typeof b.result === "object" && JSON.stringify(b.result).length <= 100_000 ? (b.result as never) : null;
    const token = req.cookies.get("b2b_auth")?.value;
    const createdBy = (await verifySession(token)) || resolveUserName(token);
    const rec = await addSavedMarginCalc({ name, question, result, createdBy });
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
