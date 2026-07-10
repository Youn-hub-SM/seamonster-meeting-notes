import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, listAdsets, listAds, getInsights, isCBO, isABO, type MetaInsight } from "@/app/lib/meta-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?datePreset=last_7d (또는 since,until) [&debug=1]
// 캠페인/광고세트/소재 + 성과 병합 + ABO/CBO 분류. 단계 판정은 클라이언트가 설정 기준으로 수행.
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const since = sp.get("since") || undefined;
    const until = sp.get("until") || undefined;
    const range = since && until ? { since, until } : { datePreset: sp.get("datePreset") || "last_7d" };
    const debug = sp.get("debug") === "1";

    const [campaigns, adsets, ads, ci, ai, adi] = await Promise.all([
      listCampaigns(), listAdsets(), listAds(),
      getInsights("campaign", range, debug), getInsights("adset", range), getInsights("ad", range),
    ]);

    const blank: MetaInsight = { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, purchases: 0, purchaseValue: 0, roas: 0, cpa: 0 };
    const out = {
      ok: true,
      campaigns: campaigns.map((c) => ({ ...c, cbo: isCBO(c), stat: ci.byId[c.id] || blank })),
      adsets: adsets.map((a) => ({ ...a, abo: isABO(a), stat: ai.byId[a.id] || blank })),
      ads: ads.map((a) => ({ ...a, stat: adi.byId[a.id] || blank })),
      ...(debug ? {
        rawInsightSample: ci.rawSample,
        debugInfo: {
          sampleKeys: ci.rawSample ? Object.keys(ci.rawSample) : [],
          sampleCampaignId: (ci.rawSample as Record<string, unknown> | undefined)?.campaign_id,
          firstCampaignId: campaigns[0]?.id,
          byIdCounts: { campaign: Object.keys(ci.byId).length, adset: Object.keys(ai.byId).length, ad: Object.keys(adi.byId).length },
        },
      } : {}),
    };
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}
