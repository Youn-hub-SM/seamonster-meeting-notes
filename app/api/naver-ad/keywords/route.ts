import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { listKeywords, getStats, updateKeywordBids, type BidUpdate, type NaverStat } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?adgroupIds=a,b (또는 adgroupId=a) &datePreset= — 여러 그룹 키워드 + 성과(7일 기본) 병합
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const groupIds = (sp.get("adgroupIds") || sp.get("adgroupId") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const datePreset = sp.get("datePreset") || "last7days";
    const debug = sp.get("debug") === "1";
    if (!groupIds.length) return NextResponse.json({ ok: false, error: "adgroupIds 가 필요합니다." }, { status: 400 });
    if (groupIds.length > 30) return NextResponse.json({ ok: false, error: "한 번에 최대 30개 그룹까지 조회할 수 있습니다." }, { status: 400 });

    let statError: string | undefined;
    // 그룹별로 키워드 + 성과 병합 (한 그룹 실패해도 나머지는 반환)
    const perGroup = await Promise.all(groupIds.map(async (agId) => {
      try {
        const keywords = await listKeywords(agId);
        const ids = keywords.map((k) => k.nccKeywordId);
        let statById: Record<string, NaverStat> = {};
        if (ids.length) {
          try {
            const stats = await getStats(ids, datePreset);
            statById = Object.fromEntries((stats || []).map((s) => [s.id, s]));
          } catch (e) { if (!statError) statError = String((e as Error)?.message || e); }
        }
        return keywords.map((k) => ({ ...k, stat: statById[k.nccKeywordId] || null }));
      } catch {
        return [];
      }
    }));
    const body: Record<string, unknown> = { ok: true, keywords: perGroup.flat() };
    if (debug && statError) body.statError = statError;
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "키워드 조회 실패") }, { status: 500 });
  }
}

// PUT { updates: [{nccKeywordId, bidAmt, useGroupBidAmt}] } — 입찰가 일괄 조정(최대 200)
export async function PUT(req: NextRequest) {
  try {
    const { updates } = (await req.json()) as { updates?: BidUpdate[] };
    if (!Array.isArray(updates) || updates.length === 0) return NextResponse.json({ ok: false, error: "변경할 입찰가가 없습니다." }, { status: 400 });
    if (updates.length > 200) return NextResponse.json({ ok: false, error: "한 번에 최대 200개까지 변경할 수 있습니다." }, { status: 400 });
    const clean = updates.map((u) => ({ nccKeywordId: String(u.nccKeywordId), bidAmt: Math.max(0, Math.round(Number(u.bidAmt) || 0)), useGroupBidAmt: !!u.useGroupBidAmt }));
    const result = await updateKeywordBids(clean);
    return NextResponse.json({ ok: true, updated: result?.length ?? clean.length, keywords: result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입찰가 변경 실패") }, { status: 500 });
  }
}
