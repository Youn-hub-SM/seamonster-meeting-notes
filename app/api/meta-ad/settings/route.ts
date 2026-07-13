import { NextRequest, NextResponse } from "next/server";
import { getMetaThresholds, saveMetaThresholds, type MetaThresholds } from "@/app/lib/meta-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, thresholds: await getMetaThresholds() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<MetaThresholds>;
    const num = (v: unknown) => (v == null || v === "" ? undefined : Math.max(0, Number(v) || 0));
    const clean: Partial<MetaThresholds> = {};
    for (const k of ["minSpend", "testDailyPerCreative", "testDays", "aboPassRoas", "aboMaxCpa", "aboMinPurchases", "scaleRoas", "scaleDays", "scalePct", "declineRoas"] as const) {
      const v = num(body[k]); if (v !== undefined) clean[k] = v;
    }
    if (typeof body.beatLiveCampaign === "boolean") clean.beatLiveCampaign = body.beatLiveCampaign;
    return NextResponse.json({ ok: true, thresholds: await saveMetaThresholds(clean) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "저장 실패" }, { status: 500 });
  }
}
