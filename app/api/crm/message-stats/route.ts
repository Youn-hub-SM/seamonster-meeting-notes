import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { messageStats, weekStartOf, kstToday } from "@/app/lib/crm-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?id=<crm_messages.id>&week=YYYY-MM-DD(끝 주, 아무 날짜나) → 메시지 하나의 12주 이력 + GA 날짜·term 별 (2026-11-09 '살펴보기' 보기)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const id = (sp.get("id") || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const raw = sp.get("week") || kstToday();
    if (!DATE_RE.test(raw)) return NextResponse.json({ ok: false, error: "week 는 YYYY-MM-DD 여야 합니다." }, { status: 400 });
    const st = await messageStats(id, weekStartOf(raw), 12);
    return NextResponse.json({ ok: true, ...st });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
