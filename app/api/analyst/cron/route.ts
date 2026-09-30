import { NextRequest, NextResponse, after } from "next/server";
import { runReport, dailySpec } from "@/app/lib/analyst";
import { weeklySpec, monthlySpec } from "@/app/lib/analyst-period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 종합 리포트 14:30 자동 발송 — 담당자가 발송하지 못한 날의 보험. pg_cron 이 호출:
//  일일 = 매일 14:30(122 'daily-analyst', 어제) · 주간 = 월~수 14:35(124 'weekly-analyst', ?period=weekly — 지난주)
//  · 월간 = 매월 1~5일 14:40(124 'monthly-analyst', ?period=monthly — 지난달).
//  매출이 다 들어왔고 '매출이 반영된 리포트'를 보낸 적이 없을 때만 생성(담당자 리포트가 그대로 유효하면 그 본문)·발송한다.
//  pg_net 은 약 55초 뒤 연결을 끊으므로 곧바로 응답하고, 분석은 응답 뒤(after)에서 끝까지 돌린다(maxDuration 300 안). 끄기 = kv analyst_auto=off.
//  인증: CRON_SECRET 또는 DIGEST_CRON_KEY (옛 06:30 브리핑 크론과 같은 관례).
export async function GET(req: NextRequest) {
  const startedAt = Date.now(); // 분석 마감(270초)은 요청 시작 기준
  const authz = req.headers.get("authorization") || "";
  const matches = (k: string | undefined) => !!k && authz === `Bearer ${k}`;
  if (!matches(process.env.CRON_SECRET) && !matches(process.env.DIGEST_CRON_KEY))
    return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  const period = req.nextUrl.searchParams.get("period");
  const spec = period === "weekly" ? weeklySpec() : period === "monthly" ? monthlySpec() : dailySpec();
  after(async () => {
    try {
      const r = await runReport(spec, { trigger: "cron", startedAt });
      if (!r.ok) console.error(`[analyst cron ${spec.period}] 실패`, r.error); // 분석 실패·발송 실패 모두
    } catch (e) { console.error(`[analyst cron ${spec.period}] 오류`, e); }
  });
  return NextResponse.json({ ok: true, queued: true, period: spec.period, key: spec.key });
}
