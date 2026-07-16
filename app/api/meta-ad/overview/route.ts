import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, listAdsets, listAds, getInsights, getDailyInsights, isCBO, isABO, type MetaInsight } from "@/app/lib/meta-ad";
import { getMetaThresholds } from "@/app/lib/meta-settings";
import { getScaleLog } from "@/app/lib/meta-scale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 짧은 캐시(90초) — 계정 전체 이력을 매번 Graph에서 다 긁는 비용을 줄임. ?fresh=1 이면 무시.
//  Vercel 웜 인스턴스 내 재조회·기간 토글이 즉시 뜸. 광고 인사이트는 어차피 수 분 단위 갱신이라 신선도 문제 없음.
//  ⚠ 켜기끄기·증액처럼 값을 바꾼 직후에는 반드시 fresh=1 로 부를 것(안 그러면 바뀌기 전 데이터가 최대 90초 남음).
const CACHE_TTL = 90_000;
const cache = new Map<string, { at: number; data: unknown }>();

// KST 기준 N일 전 날짜(YYYY-MM-DD). 메타 인사이트는 광고계정 시간대(서울) 기준이라 UTC로 계산하면 하루가 밀린다.
const kstYmd = (back: number) => new Date(Date.now() + 9 * 3600e3 - back * 86_400e3).toISOString().slice(0, 10);

// '연속 N일 유지' 판정용 창 — 어제까지의 완료된 N일.
//  오늘을 넣으면 아직 반쯤 찬 하루(지출은 있는데 전환은 아직)가 연속을 끊어 증액 권장이 영영 안 뜬다.
const scaleWindow = (days: number) => ({ since: kstYmd(Math.max(1, days)), until: kstYmd(1) });

// GET ?datePreset=last_7d (또는 since,until) [&debug=1] [&fresh=1]
// 캠페인/광고세트/소재 + 성과 병합 + ABO/CBO 분류. 단계 판정은 클라이언트가 설정 기준으로 수행.
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const since = sp.get("since") || undefined;
    const until = sp.get("until") || undefined;
    const range = since && until ? { since, until } : { datePreset: sp.get("datePreset") || "last_7d" };
    const debug = sp.get("debug") === "1";
    const fresh = sp.get("fresh") === "1";
    const activeOnly = sp.get("scope") !== "all"; // 기본: 게재 중만(빠름). scope=all 이면 전체(ACTIVE+PAUSED)

    // 기준값이 먼저 있어야 '연속 N일' 창을 정할 수 있어 Graph 호출보다 앞선다(둘 다 KV 조회라 빠름).
    const [thresholds, scaleLog] = await Promise.all([getMetaThresholds(), getScaleLog()]);
    const scaleRange = scaleWindow(thresholds.scaleDays);

    // scaleDays 가 바뀌면 창이 달라지므로 캐시 키에 포함.
    const cacheKey = JSON.stringify({ range, activeOnly, scaleDays: thresholds.scaleDays });
    if (!debug && !fresh) {
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL) {
        return NextResponse.json({ ...(hit.data as object), cached: true });
      }
    }

    const [campaigns, adsets, ads, ci, ai, adi, dailyByCampaign] = await Promise.all([
      listCampaigns(activeOnly), listAdsets(activeOnly), listAds(activeOnly),
      getInsights("campaign", range, debug), getInsights("adset", range), getInsights("ad", range),
      getDailyInsights("campaign", scaleRange),
    ]);

    const blank: MetaInsight = { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, purchases: 0, purchaseValue: 0, roas: 0, cpa: 0 };
    const out = {
      ok: true,
      thresholds,
      scaleLog,
      scaleRange, // 화면에 '언제부터 언제까지 연속인지' 표시용
      // daily = 증액 판정용 최근 N일(보드에서 고른 기간과 무관). 판정 자체는 클라이언트가 기준값으로 수행.
      campaigns: campaigns.map((c) => ({ ...c, cbo: isCBO(c), stat: ci.byId[c.id] || blank, daily: dailyByCampaign[c.id] || [] })),
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
    if (!debug) cache.set(cacheKey, { at: Date.now(), data: out });
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}
