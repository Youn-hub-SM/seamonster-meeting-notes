import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getMeetingTerms, addMeetingTerm, removeMeetingTerm } from "@/app/lib/meeting-terms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 공유 용어집 조회
export async function GET() {
  try {
    return NextResponse.json({ ok: true, terms: await getMeetingTerms() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { term, note? } — 추가(중복이면 409)
export async function POST(req: NextRequest) {
  try {
    const { term, note } = (await req.json()) as { term?: string; note?: string };
    const r = await addMeetingTerm(String(term ?? ""), typeof note === "string" ? note : "");
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error, terms: r.terms }, { status: 409 });
    return NextResponse.json({ ok: true, terms: r.terms });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// DELETE ?term=... — 삭제
export async function DELETE(req: NextRequest) {
  try {
    const term = new URL(req.url).searchParams.get("term") || "";
    return NextResponse.json({ ok: true, terms: await removeMeetingTerm(term) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
