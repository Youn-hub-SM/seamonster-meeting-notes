import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { applyBoltaWebhook } from "@/app/lib/tax-invoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/b2b/tax-invoices/webhook — 볼타 발행 결과(TAX_INVOICE_ISSUANCE_SUCCESS / _FAILURE). 미들웨어 공개 예외.
//  볼타 웹훅엔 서명이 없어(문서) 내용을 믿지 않고 조회 API 로 다시 확인한다(applyBoltaWebhook).
//  env BOLTA_WEBHOOK_KEY 를 두면 수신 URL 에 ?key=<값> 이 있어야 받는다(볼타 개발자센터 '발행 수신 URL'에 붙여 등록).
//  실패 알림은 이 키가 있을 때만 반영한다(키가 없으면 성공 확인용으로만 쓰고, 실패는 화면의 [실패로 처리]로).
export async function POST(req: NextRequest) {
  try {
    const need = (process.env.BOLTA_WEBHOOK_KEY || "").trim();
    if (need && new URL(req.url).searchParams.get("key") !== need) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const payload = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await applyBoltaWebhook(supabaseAdmin(), payload, !!need);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[b2b/tax-invoices/webhook]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
