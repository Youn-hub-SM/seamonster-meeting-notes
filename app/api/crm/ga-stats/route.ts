import { NextRequest, NextResponse } from "next/server";
import { isGaConfigured, getCampaignStats, type GaCampaignStat } from "@/app/lib/ga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GA 데이터는 처리 지연(최대 24~48h)이 있어 신선도가 낮다 → 10분 인메모리 캐시로 API 쿼터 절약.
const CACHE_TTL = 10 * 60_000;
const cache = new Map<string, { at: number; stats: Record<string, GaCampaignStat> }>();

// GET ?campaigns=a,b,c[&days=90] — utm_campaign 별 GA 성과(세션·구매·매출).
//  env 미설정이면 configured:false 로 정상 응답(화면은 조용히 수동 perf 만 표시).
export async function GET(req: NextRequest) {
  try {
    if (!isGaConfigured()) return NextResponse.json({ ok: true, configured: false, stats: {} });
    const sp = new URL(req.url).searchParams;
    const campaigns = (sp.get("campaigns") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const days = Math.min(365, Math.max(1, Number(sp.get("days")) || 90));
    if (campaigns.length === 0) return NextResponse.json({ ok: true, configured: true, stats: {} });

    const key = JSON.stringify({ c: [...campaigns].sort(), days });
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      return NextResponse.json({ ok: true, configured: true, stats: hit.stats, cached: true });
    }
    const stats = await getCampaignStats(campaigns, days);
    cache.set(key, { at: Date.now(), stats });
    return NextResponse.json({ ok: true, configured: true, stats });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "GA 조회 실패" }, { status: 500 });
  }
}
