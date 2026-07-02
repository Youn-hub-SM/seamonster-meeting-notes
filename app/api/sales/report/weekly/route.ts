import { NextRequest, NextResponse } from "next/server";
import { computeWeeklyStats, buildWeeklyText, maxOrderDate } from "@/app/lib/sales-report";
import { buildWeeklyHtml } from "@/app/lib/sales-report-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 주간 리포트 '미리보기'(DB 미기록). base가 속한 주(월~일). 생략 시 데이터 최신일 기준.
export async function GET(req: NextRequest) {
  try {
    const base = new URL(req.url).searchParams.get("base") || (await maxOrderDate());
    if (!base) return NextResponse.json({ ok: false, error: "매출 데이터가 없습니다." }, { status: 400 });
    const s = await computeWeeklyStats(base);
    return NextResponse.json({
      ok: true, report_type: "weekly", base_date: base, period_start: s.week_start, period_end: s.week_end,
      subject: `[씨몬스터] 주간 매출 리포트 - ${s.week_start} ~ ${s.week_end}`,
      html: buildWeeklyHtml(s), text: buildWeeklyText(s),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
