import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv } from "@/app/lib/b2b-settings";
import { generateBriefing, sendBriefingToTeams } from "@/app/lib/briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 아침 브리핑 크론 (migration 103 의 pg_cron 이 06:30 KST 에 호출).
//  Vercel Hobby 크론 2개가 이미 일정 브리핑에 쓰여 092 와 같은 pg_cron + http 방식을 쓴다.
//  인증: CRON_SECRET 또는 DIGEST_CRON_KEY (schedule-digest 와 동일 관례, 헤더/쿼리 양쪽 인정).
export async function GET(req: NextRequest) {
  try {
    const authz = req.headers.get("authorization") || "";
    const sp = req.nextUrl.searchParams;
    const matches = (k: string | undefined) => !!k && (authz === `Bearer ${k}` || sp.get("key") === k);
    if (!matches(process.env.CRON_SECRET) && !matches(process.env.DIGEST_CRON_KEY))
      return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

    // 끄기 옵션 — 반복 AI 호출 비용 통제(설정 briefing_auto = "off")
    if ((await getKv("briefing_auto")) === "off")
      return NextResponse.json({ ok: true, skipped: "자동 생성 꺼짐" });

    const r = await generateBriefing(); // 오늘자, 이미 있으면 스킵(멱등)
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 500 });

    // 최초 생성시에만 발송(재실행·재시도에 중복 발송 방지). 웹훅 미설정이면 조용히 생략.
    let sent: { ok: boolean; error?: string } | null = null;
    if (!r.skipped) {
      try { sent = await sendBriefingToTeams(r.date); } catch { sent = { ok: false, error: "발송 실패" }; }
    }
    return NextResponse.json({ ok: true, date: r.date, skipped: r.skipped ?? null, sent });
  } catch (err) {
    console.error("[briefing cron]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "브리핑 크론 실패") }, { status: 500 });
  }
}
