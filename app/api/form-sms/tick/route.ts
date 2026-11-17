import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { markTick, tickFormSms, isMissingFormSms } from "@/app/lib/form-sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const authed = (req: NextRequest) => {
  const authz = req.headers.get("authorization") || "";
  return [process.env.DIGEST_CRON_KEY, process.env.CRON_SECRET].some((k) => !!k && authz === `Bearer ${k}`);
};

// POST — 옛 예약 신호(Supabase pg_cron, migration 167 — 매일 13:00 한 번). 2026-11-18 Vercel 크론(GET)으로 옮긴 뒤로는
//  받기만 하고 끝낸다. migration 170 으로 끈다(168 은 적용하지 않는다).
export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  return NextResponse.json({ ok: true, skipped: "moved-to-vercel-cron" });
}

// GET — 신청자 문자 예약 신호. Vercel 크론이 5분마다 두드린다(vercel.json, Authorization: Bearer CRON_SECRET).
//  보낼 차례인지는 설정(마케팅 › 신청자 문자 — 매일 hh:mm 또는 즉시)을 보고 앱이 정한다. 차례가 아니면 즉시 끝난다.
//  같은 신청에 두 번 보내지 않는 것은 form_sms_sends.response_id unique 가 지킨다 — 신호가 두 번 와도 안전하다.
//  미들웨어 보호 밖(로그인 쿠키 없이 온다) — 키 검증이 유일한 문이다.
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  await markTick().catch(() => {});
  try {
    return NextResponse.json(await tickFormSms(supabaseAdmin()));
  } catch (e) {
    console.error("[form-sms/tick]", e);
    const msg = isMissingFormSms(e as { message?: string }) ? "migration 167 미적용" : e instanceof Error ? e.message : "오류";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
