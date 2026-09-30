import { NextRequest, NextResponse, after } from "next/server";
import { runDailyAnalyst } from "@/app/lib/analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 일일 종합 리포트 14:30 자동 발송 (migration 122 의 pg_cron 이 14:30 KST 에 호출) — 담당자가 발송하지 못한 날의 보험.
//  어제 매출이 있고 아직 발송 전일 때만 생성(담당자 보고서가 그대로 유효하면 그 본문)·발송한다. 매출이 없으면 아무것도 안 한다.
//  pg_net 은 약 55초 뒤 연결을 끊으므로 곧바로 응답하고, 분석은 응답 뒤(after)에서 끝까지 돌린다(maxDuration 300 안). 끄기 = kv analyst_auto=off.
//  인증: CRON_SECRET 또는 DIGEST_CRON_KEY (옛 06:30 브리핑 크론과 같은 관례).
export async function GET(req: NextRequest) {
  const startedAt = Date.now(); // 분석 마감(270초)은 요청 시작 기준
  const authz = req.headers.get("authorization") || "";
  const matches = (k: string | undefined) => !!k && authz === `Bearer ${k}`;
  if (!matches(process.env.CRON_SECRET) && !matches(process.env.DIGEST_CRON_KEY))
    return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  after(async () => {
    try {
      const r = await runDailyAnalyst({ trigger: "cron", startedAt });
      if (!r.ok) console.error("[analyst cron] 실패", r.error); // 분석 실패·발송 실패 모두
    } catch (e) { console.error("[analyst cron] 오류", e); }
  });
  return NextResponse.json({ ok: true, queued: true });
}
