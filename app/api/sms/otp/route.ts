import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { handleOtpSms } from "@/app/lib/sms-otp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/sms/otp — 알리고 인증 문자('[알리고 문자]' 머리말)를 Teams 로 전달 (2026-10-22). 입금 문자 웹훅(/api/b2b/deposits/webhook)과 같은 방식.
//  폰의 자동화 앱(아이폰 단축어·MacroDroid)이 문자를 받으면 이 주소로 보낸다.
//  body: { text: "<문자 원문>" }  (message / body 키도 받는다 — 앱마다 이름이 다르다)
//  인증: ?key= 또는 X-Webhook-Key 헤더 = DEPOSIT_WEBHOOK_SECRET (없으면 CRON_SECRET 겸용) — 입금 웹훅과 같은 키.
//  ?dry=1 : 보내지 않고 파싱 결과만 반환 (연동 테스트용).
//  미들웨어 공개 예외 경로 — 여기서 직접 검증한다. 알리고 인증 문자가 아니면 Teams 로 가지 않는다(다른 서비스 인증 문자 포함).

export async function POST(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const secret = process.env.DEPOSIT_WEBHOOK_SECRET || process.env.CRON_SECRET || "";
    const key = sp.get("key") || req.headers.get("x-webhook-key") || "";
    if (!secret || key !== secret) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

    const ct = req.headers.get("content-type") || "";
    let text = "";
    if (/json/i.test(ct)) {
      const b = (await req.json().catch(() => ({}))) as { text?: unknown; message?: unknown; body?: unknown };
      text = String(b.text ?? b.message ?? b.body ?? "");
    } else {
      // 단축어 '양식'(form) 이나 평문으로 보내는 경우
      const raw = await req.text().catch(() => "");
      if (/form-urlencoded/i.test(ct)) { const f = new URLSearchParams(raw); text = f.get("text") || f.get("message") || f.get("body") || ""; }
      else text = raw;
    }
    if (!text.trim()) return NextResponse.json({ ok: false, error: "text 가 비어 있습니다." }, { status: 400 });

    const r = await handleOtpSms(text, { dry: sp.get("dry") === "1" });
    if (!r.matched) console.log(`[sms otp] 알리고 인증 문자 아님 — 무시: ${text.replace(/\s+/g, " ").slice(0, 60)}`);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
