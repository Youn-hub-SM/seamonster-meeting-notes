import { NextRequest, NextResponse } from "next/server";
import { isGaConfigured, getCampaignStats, getCampaignDaily, type GaCampaignStat, type GaDailyRow } from "@/app/lib/ga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GA 데이터는 처리 지연(최대 24~48h)이 있어 신선도가 낮다 → 10분 인메모리 캐시로 API 쿼터 절약.
const CACHE_TTL = 10 * 60_000;
const cache = new Map<string, { at: number; data: { stats: Record<string, GaCampaignStat>; daily?: GaDailyRow[] } }>();

// GET ?campaigns=a,b,c[&days=90][&daily=1] — utm_campaign 별 GA 성과(세션·구매·매출).
//  daily=1 이면 날짜×캠페인 일자별 행도 함께(통계 탭 추이용). 이때 합계는 일자별에서 파생(호출 1번).
//  env 미설정이면 configured:false 로 정상 응답(화면은 조용히 수동 perf 만 표시).
export async function GET(req: NextRequest) {
  try {
    if (!isGaConfigured()) return NextResponse.json({ ok: true, configured: false, stats: {} });
    const sp = new URL(req.url).searchParams;
    const campaigns = (sp.get("campaigns") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const days = Math.min(365, Math.max(1, Number(sp.get("days")) || 90));
    const wantDaily = sp.get("daily") === "1";
    if (campaigns.length === 0) return NextResponse.json({ ok: true, configured: true, stats: {} });

    const key = JSON.stringify({ c: [...campaigns].sort(), days, wantDaily });
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      return NextResponse.json({ ok: true, configured: true, ...hit.data, cached: true });
    }

    let data: { stats: Record<string, GaCampaignStat>; daily?: GaDailyRow[] };
    if (wantDaily) {
      const daily = await getCampaignDaily(campaigns, days);
      const stats: Record<string, GaCampaignStat> = {};
      for (const r of daily) {
        const s = (stats[r.campaign] ||= { sessions: 0, users: 0, purchases: 0, revenue: 0 });
        s.sessions += r.sessions; s.purchases += r.purchases; s.revenue += r.revenue;
        // users 는 일자 합산 시 중복 계산이라 일자별 모드에선 제공하지 않음(0 유지)
      }
      data = { stats, daily };
    } else {
      data = { stats: await getCampaignStats(campaigns, days) };
    }
    cache.set(key, { at: Date.now(), data });
    return NextResponse.json({ ok: true, configured: true, ...data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "GA 조회 실패" }, { status: 500 });
  }
}
