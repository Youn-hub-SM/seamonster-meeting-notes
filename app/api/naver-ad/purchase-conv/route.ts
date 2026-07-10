import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getPurchaseConversions } from "@/app/lib/naver-conv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?type=keyword|adgroup & since=YYYY-MM-DD & until=YYYY-MM-DD
// 기간 내 '구매(purchase)' 전환수/매출을 엔티티별로 반환. (AD_CONVERSION_DETAIL 리포트 기반, 일별 캐시)
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const type = sp.get("type") === "adgroup" ? "adgroup" : "keyword";
    const since = sp.get("since") || "";
    const until = sp.get("until") || "";
    if (!since || !until) return NextResponse.json({ ok: false, error: "since·until(YYYY-MM-DD) 가 필요합니다." }, { status: 400 });
    // 최대 62일 안전장치는 lib 내부. 여기선 역전만 방지
    if (since > until) return NextResponse.json({ ok: false, error: "기간이 올바르지 않습니다." }, { status: 400 });
    const { map, daysFetched, cached, effectiveUntil } = await getPurchaseConversions(since, until, type);
    return NextResponse.json({ ok: true, type, since, until, effectiveUntil, map, daysFetched, cached });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "구매 전환 조회 실패") }, { status: 500 });
  }
}
