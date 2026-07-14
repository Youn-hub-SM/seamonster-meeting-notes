import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

// GET /q/{code} — 공개 리다이렉트. 스캔 기록 + 카운트 증가 후 목적지로 302.
//  미들웨어에서 /q/* 는 인증 제외(스캐너는 비로그인). 목적지·카운트는 qr_resolve RPC 로 1회 처리.
export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params;
  try {
    const sb = supabaseAdmin();
    const referer = req.headers.get("referer") || "";
    const ua = req.headers.get("user-agent") || "";
    const country = req.headers.get("x-vercel-ip-country") || ""; // Vercel 제공, 대략 국가(개인식별 아님)
    const { data, error } = await sb.rpc("qr_resolve", { p_code: code, p_referer: referer, p_ua: ua, p_country: country });
    if (error) throw error;
    const target = typeof data === "string" && data ? data : null;
    if (target) {
      const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
      return NextResponse.redirect(url, 302);
    }
  } catch (e) {
    console.error("[q redirect]", e);
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>링크 없음</title><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:88vh;color:#333;text-align:center;margin:0"><div><div style="font-size:44px"></div><p>이 링크는 존재하지 않거나 비활성 상태입니다.</p></div></body>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
