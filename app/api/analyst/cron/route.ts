import { NextRequest, NextResponse, after } from "next/server";
import { runDailyAnalyst } from "@/app/lib/analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 어제 분석 예약 실행 (migration 122 의 pg_cron 이 14:30 KST 에 호출) — 매출 업로드 직후 실행을 놓친 날의 보험.
//  pg_net 은 약 55초 뒤 연결을 끊으므로 곧바로 응답하고, 분석은 응답 뒤(after)에서 끝까지 돌린다(maxDuration 300 안).
//  매출이 아직 없으면 광고만 먼저 보고하고, 이미 분석된 날은 건너뛴다(runDailyAnalyst 멱등). 끄기 = kv analyst_auto=off.
//  인증: CRON_SECRET 또는 DIGEST_CRON_KEY (일일 리포트 크론과 같은 관례).
export async function GET(req: NextRequest) {
  const startedAt = Date.now(); // 분석 마감(270초)은 요청 시작 기준
  const authz = req.headers.get("authorization") || "";
  const matches = (k: string | undefined) => !!k && authz === `Bearer ${k}`;
  if (!matches(process.env.CRON_SECRET) && !matches(process.env.DIGEST_CRON_KEY))
    return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date"); // 있으면 매출 변경 재분석(analyst.ts kickRerun) — 없으면 어제
  after(async () => {
    try {
      const r = await runDailyAnalyst(date ? { trigger: "rerun", date, startedAt } : { trigger: "cron", startedAt });
      if (!r.ok) console.error("[analyst cron] 실패", r.error);
    } catch (e) { console.error("[analyst cron] 오류", e); }
  });
  return NextResponse.json({ ok: true, queued: true });
}
