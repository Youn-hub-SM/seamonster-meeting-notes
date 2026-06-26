import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { setSafetyAdjust } from "@/app/lib/production-safety-adjust";

export const dynamic = "force-dynamic";

// PUT { sku, delta, excludeOut?, memo?, until? } — SKU별 안전재고 수동 보정 저장.
//  delta=0 & excludeOut=0 & 메모 없으면 보정 제거(기본 복귀).
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { sku?: string; delta?: number; excludeOut?: number; memo?: string; until?: string | null };
    if (!body.sku) return NextResponse.json({ ok: false, error: "sku 가 필요합니다." }, { status: 400 });
    const adjusts = await setSafetyAdjust(body.sku, {
      delta: Number(body.delta) || 0,
      excludeOut: Number(body.excludeOut) || 0,
      memo: body.memo,
      until: body.until ?? null,
    });
    return NextResponse.json({ ok: true, adjusts });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
