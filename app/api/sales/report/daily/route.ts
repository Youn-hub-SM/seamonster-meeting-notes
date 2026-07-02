import { NextRequest, NextResponse } from "next/server";
import { computeDailyStats, buildDailyText } from "@/app/lib/sales-report";
import { buildDailyHtml } from "@/app/lib/sales-report-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 일일 리포트 '미리보기' 생성(DB 미기록). base 생략 시 데이터 최신일.
export async function GET(req: NextRequest) {
  try {
    const base = new URL(req.url).searchParams.get("base") || undefined;
    const s = await computeDailyStats(base);
    return NextResponse.json({
      ok: true, report_type: "daily", base_date: s.date_str, is_sunday: s.is_sunday,
      subject: `[씨몬스터] 일일 매출 리포트 - ${s.date_str}`,
      html: buildDailyHtml(s), text: buildDailyText(s),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
