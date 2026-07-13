import { NextRequest, NextResponse } from "next/server";
import { getStatsByDay } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET ?id=광고그룹/키워드 &since=YYYY-MM-DD &until=YYYY-MM-DD [&debug=1]
//  선택한 대상의 일자별 성과. 주별·월별 집계는 클라이언트가 수행.
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const id = sp.get("id");
    const since = sp.get("since"), until = sp.get("until");
    if (!id) return NextResponse.json({ ok: false, error: "id 필수" }, { status: 400 });
    if (!since || !until) return NextResponse.json({ ok: false, error: "기간(since·until) 필수" }, { status: 400 });
    const { days, rawSample } = await getStatsByDay(id, { since, until });
    return NextResponse.json({ ok: true, days, ...(sp.get("debug") === "1" ? { rawSample } : {}) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "리포트 조회 실패" }, { status: 500 });
  }
}
