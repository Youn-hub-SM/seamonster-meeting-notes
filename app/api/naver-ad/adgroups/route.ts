import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { listAdgroups } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?campaignId=... — 캠페인 하위 광고그룹
export async function GET(req: NextRequest) {
  try {
    const campaignId = new URL(req.url).searchParams.get("campaignId") || "";
    if (!campaignId) return NextResponse.json({ ok: false, error: "campaignId 가 필요합니다." }, { status: 400 });
    return NextResponse.json({ ok: true, adgroups: await listAdgroups(campaignId) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "광고그룹 조회 실패") }, { status: 500 });
  }
}
