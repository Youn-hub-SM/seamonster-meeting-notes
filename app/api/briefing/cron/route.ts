import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 06:30 업무 브리핑 자동 생성 — 2026-09-30 중단(대표 결정: 06:30 생성은 무의미, 일일 리포트는 매출 업로드 뒤 담당자가 생성·발송).
//  migration 123 이 pg_cron 작업(daily-briefing)을 지운다. 적용 전에 호출돼도 아무것도 하지 않는다.
//  브리핑 본체(app/lib/briefing.ts, /api/briefing)는 관리자용 리포트를 다시 만들 때 재활용하려고 남겨 둔다.
//  인증: CRON_SECRET 또는 DIGEST_CRON_KEY (schedule-digest 와 동일 관례, 헤더/쿼리 양쪽 인정).
export async function GET(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const sp = req.nextUrl.searchParams;
  const matches = (k: string | undefined) => !!k && (authz === `Bearer ${k}` || sp.get("key") === k);
  if (!matches(process.env.CRON_SECRET) && !matches(process.env.DIGEST_CRON_KEY))
    return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  return NextResponse.json({ ok: true, skipped: "06:30 업무 브리핑 중단(2026-09-30)" });
}
