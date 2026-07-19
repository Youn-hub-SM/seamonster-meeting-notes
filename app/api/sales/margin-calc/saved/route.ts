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

// POST { name, question, specs?, result? } → 저장
//  specs = 계산 레시피(있으면 클릭 시 AI 없이 현재 기준 재계산) · result = 스냅샷(스펙 없을 때 폴백)
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { name?: string; question?: string; specs?: unknown; result?: unknown };
    const name = (b.name || "").trim();
    const question = (b.question || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "이름을 입력하세요." }, { status: 400 });
    if (!question) return NextResponse.json({ ok: false, error: "질문이 비어 있습니다." }, { status: 400 });
    const specs = Array.isArray(b.specs) && b.specs.length > 0 && JSON.stringify(b.specs).length <= 50_000 ? (b.specs as never) : null;
    // 스냅샷 크기 상한 — KV 리스트가 비대해지지 않게. 스펙이 있으면 스냅샷은 불필요(현재 기준 즉시 계산이 더 정확)
    const result = !specs && b.result && typeof b.result === "object" && JSON.stringify(b.result).length <= 100_000 ? (b.result as never) : null;
    const token = req.cookies.get("b2b_auth")?.value;
    const createdBy = (await verifySession(token)) || resolveUserName(token);
    const rec = await addSavedMarginCalc({ name, question, specs, result, createdBy });
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
