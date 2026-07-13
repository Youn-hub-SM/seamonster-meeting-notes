import { NextRequest, NextResponse } from "next/server";
import { getStatsByDay } from "@/app/lib/naver-ad";
import { getPurchaseConvByDay } from "@/app/lib/naver-conv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?id=광고그룹/키워드 &since=YYYY-MM-DD &until=YYYY-MM-DD
//   [&type=keyword|adgroup] [&conv=all|purchase] [&debug=1]
//  선택한 대상의 일자별 성과. 주별·월별 집계는 클라이언트가 수행.
//  conv=purchase: 전환수/전환매출/ROAS를 '구매 전환' 기준으로 대체(무거워 최근 62일로 제한).
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const id = sp.get("id");
    const since = sp.get("since"), until = sp.get("until");
    if (!id) return NextResponse.json({ ok: false, error: "id 필수" }, { status: 400 });
    if (!since || !until) return NextResponse.json({ ok: false, error: "기간(since·until) 필수" }, { status: 400 });
    const type = sp.get("type") === "adgroup" ? "adgroup" : "keyword";
    const conv = sp.get("conv") === "purchase" ? "purchase" : "all";
    const debug = sp.get("debug") === "1";

    if (conv === "purchase") {
      // 구매전환(AD_CONVERSION_DETAIL)은 무거워 최근 62일까지만 제공
      let effSince = since, capped = false;
      const su = Date.parse(`${until}T00:00:00Z`), ss = Date.parse(`${since}T00:00:00Z`);
      const maxSpan = 61 * 864e5;
      if (Number.isFinite(su) && Number.isFinite(ss) && su - ss > maxSpan) {
        effSince = new Date(su - maxSpan).toISOString().slice(0, 10);
        capped = true;
      }
      const [stat, pc] = await Promise.all([
        getStatsByDay(id, { since: effSince, until }),
        getPurchaseConvByDay(id, type, effSince, until),
      ]);
      const days = stat.days;
      const pm = new Map(pc.days.map((d) => [d.date, d]));
      for (const d of days) {
        const p = pm.get(d.date);
        d.ccnt = p ? p.conv : 0;          // 구매 전환수
        d.convAmt = p ? p.sales : 0;      // 구매 전환매출
        d.ror = d.salesAmt > 0 ? (d.convAmt / d.salesAmt) * 100 : 0; // salesAmt=광고비
        d.cpConv = p && p.conv > 0 ? d.salesAmt / p.conv : undefined;
      }
      return NextResponse.json({ ok: true, days, conv, capped, effectiveSince: effSince, effectiveUntil: pc.effectiveUntil, cached: pc.cached, ...(debug ? { rawSample: stat.rawSample } : {}) });
    }

    const { days, rawSample } = await getStatsByDay(id, { since, until });
    return NextResponse.json({ ok: true, days, conv, ...(debug ? { rawSample } : {}) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "리포트 조회 실패" }, { status: 500 });
  }
}
