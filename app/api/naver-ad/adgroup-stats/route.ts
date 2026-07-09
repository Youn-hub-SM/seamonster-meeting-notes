import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { listAdgroupsWithStats, updateAdgroupBids, type AdgroupBidUpdate } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?campaignIds=a,b &datePreset= (또는 since,until) — 캠페인 하위 광고그룹 + 성과(쇼핑검색 등 그룹단위 뷰).
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const campaignIds = (sp.get("campaignIds") || sp.get("campaignId") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!campaignIds.length) return NextResponse.json({ ok: false, error: "campaignIds 가 필요합니다." }, { status: 400 });
    const since = sp.get("since") || undefined;
    const until = sp.get("until") || undefined;
    const range = since && until ? { since, until } : { datePreset: sp.get("datePreset") || "last7days" };
    const adgroups = await listAdgroupsWithStats(campaignIds, range);
    return NextResponse.json({ ok: true, adgroups });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "광고그룹 성과 조회 실패") }, { status: 500 });
  }
}

// PUT { updates: [{nccAdgroupId, bidAmt}] } — 광고그룹 입찰가 일괄(개별 PUT 반복, 최대 100).
export async function PUT(req: NextRequest) {
  try {
    const { updates } = (await req.json()) as { updates?: AdgroupBidUpdate[] };
    if (!Array.isArray(updates) || updates.length === 0) return NextResponse.json({ ok: false, error: "변경할 입찰가가 없습니다." }, { status: 400 });
    if (updates.length > 100) return NextResponse.json({ ok: false, error: "한 번에 최대 100개까지 변경할 수 있습니다." }, { status: 400 });
    const clean = updates.map((u) => ({ nccAdgroupId: String(u.nccAdgroupId), bidAmt: Math.max(0, Math.round(Number(u.bidAmt) || 0)) }));
    const r = await updateAdgroupBids(clean);
    if (r.failed > 0 && r.updated === 0) return NextResponse.json({ ok: false, error: r.firstError || "입찰가 변경 실패" }, { status: 500 });
    return NextResponse.json({ ok: true, updated: r.updated, failed: r.failed, error: r.failed ? r.firstError : undefined });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입찰가 변경 실패") }, { status: 500 });
  }
}
