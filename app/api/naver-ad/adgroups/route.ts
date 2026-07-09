import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { listAdgroups } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?campaignIds=a,b,c (또는 campaignId=a) — 여러 캠페인 하위 광고그룹 합쳐서 반환
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const ids = (sp.get("campaignIds") || sp.get("campaignId") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return NextResponse.json({ ok: false, error: "campaignIds 가 필요합니다." }, { status: 400 });
    const results = await Promise.all(ids.map((id) => listAdgroups(id).catch(() => [])));
    return NextResponse.json({ ok: true, adgroups: results.flat() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "광고그룹 조회 실패") }, { status: 500 });
  }
}
