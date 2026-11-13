import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { markTick, runFormSms, isMissingFormSms } from "@/app/lib/form-sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST — 신청자 문자 예약 신호. Supabase pg_cron 이 매일 13:00(KST)에 한 번 두드린다(migration 167, Authorization: Bearer DIGEST_CRON_KEY).
//  설정(마케팅 › 신청자 문자)이 켜져 있으면 대기 중인 신청자에게 보낸다. 꺼져 있으면 즉시 끝난다.
//  같은 신청에 두 번 보내지 않는 것은 form_sms_sends.response_id unique 가 지킨다 — 신호가 두 번 와도 안전하다.
//  미들웨어 보호 밖(로그인 쿠키 없이 온다) — 아래 키 검증이 유일한 문이다.
export async function POST(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const ok = [process.env.DIGEST_CRON_KEY, process.env.CRON_SECRET].some((k) => !!k && authz === `Bearer ${k}`);
  if (!ok) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  await markTick().catch(() => {});
  try {
    return NextResponse.json(await runFormSms(supabaseAdmin(), "예약", true));
  } catch (e) {
    console.error("[form-sms/tick]", e);
    const msg = isMissingFormSms(e as { message?: string }) ? "migration 167 미적용" : e instanceof Error ? e.message : "오류";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
