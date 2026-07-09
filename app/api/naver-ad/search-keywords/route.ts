import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getShoppingSearchKeywords } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?id=<광고그룹ID> [&raw=1] — 쇼핑검색 세부 검색어 리포트(NPLA_SCH_KEYWORD, 최근30일).
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const id = (sp.get("id") || sp.get("adgroupId") || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id(광고그룹) 가 필요합니다." }, { status: 400 });
    const rows = await getShoppingSearchKeywords(id);
    return NextResponse.json({ ok: true, keywords: rows });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "검색어 리포트 조회 실패") }, { status: 500 });
  }
}
