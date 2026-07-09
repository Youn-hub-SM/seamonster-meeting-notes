import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { listCampaigns } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, campaigns: await listCampaigns() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "캠페인 조회 실패") }, { status: 500 });
  }
}
