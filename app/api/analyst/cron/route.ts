import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 종합 리포트 14:30 자동 생성·발송 — 2026-10-13 대표 결정으로 폐지("발송은 수동으로만, 일일 매출 리포트와 동일").
//  pg_cron 예약(122 daily-analyst · 124 weekly-analyst · monthly-analyst)은 migration 138 이 해제한다. 적용 전에 예약이 이 주소를 불러도
//  아무것도 만들거나 보내지 않는다(AI 호출·메일 없음). 발송은 /briefing [보내기](POST /api/analyst {send:true}) 로만.
//  인증: CRON_SECRET 또는 DIGEST_CRON_KEY (옛 06:30 브리핑 크론과 같은 관례) — 그대로 둔다.
export async function GET(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const matches = (k: string | undefined) => !!k && authz === `Bearer ${k}`;
  if (!matches(process.env.CRON_SECRET) && !matches(process.env.DIGEST_CRON_KEY))
    return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  return NextResponse.json({ ok: true, skipped: "자동 발송 없음 — 발송은 종합 리포트 화면 [보내기]로만(2026-10-13)" });
}
