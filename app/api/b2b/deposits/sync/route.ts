import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { setKv } from "@/app/lib/b2b-settings";
import {
  collectDeposits,
  runAutoMatch,
  popbillConfigured,
  isMissingDepositsTable,
} from "@/app/lib/b2b-deposits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 팝빌 수집 완료 대기(최대 ~21초) 포함

// GET /api/b2b/deposits/sync — 팝빌 계좌조회 수집 + 자동 매칭.
//  호출 주체 둘: ① 외부 스케줄러(cron-job.org 등) — Authorization: Bearer CRON_SECRET 또는 ?key=
//  ② 화면의 [지금 동기화] — 내부 로그인 세션(파도소리 계정 제외).
//  미들웨어 공개 예외 경로라 여기서 직접 인증한다 (schedule-digest 와 같은 패턴).
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const secret = process.env.CRON_SECRET || "";
  const authz = req.headers.get("authorization") || "";
  const isCron = !!secret && (authz === `Bearer ${secret}` || sp.get("key") === secret);

  let isInternal = false;
  if (!isCron) {
    const token = req.cookies.get("b2b_auth")?.value;
    const sess = await verifySessionFull(token);
    isInternal = (sess && sess.role !== "factory") || (!sess && !!resolveUserName(token));
  }
  if (!isCron && !isInternal) {
    return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  }

  if (!popbillConfigured()) {
    return NextResponse.json(
      { ok: false, error: "팝빌 환경변수(POPBILL_LINK_ID·SECRET_KEY·CORP_NUM·ACCOUNT_NO)가 설정되지 않았습니다." },
      { status: 503 }
    );
  }

  try {
    const days = Math.min(30, Math.max(1, Number(sp.get("days")) || 7));
    const { fetched, inserted } = await collectDeposits(days);
    const { autoMatched, needReview } = await runAutoMatch(new Set(inserted.map((d) => d.id)));

    const summary = {
      at: new Date().toISOString(),
      fetched,
      inserted: inserted.length,
      autoMatched,
      needReview,
    };
    await setKv("deposits_last_sync", JSON.stringify(summary));
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    if (isMissingDepositsTable(err)) {
      return NextResponse.json(
        { ok: false, notReady: true, error: "bank_deposits 테이블이 없습니다 — 마이그레이션 089_bank_deposits.sql 을 적용하세요." },
        { status: 503 }
      );
    }
    console.error("[b2b/deposits/sync]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "동기화 실패") }, { status: 500 });
  }
}
