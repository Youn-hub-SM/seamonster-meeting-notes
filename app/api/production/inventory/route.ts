import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getInventoryRows } from "@/app/lib/production-inventory";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/production/inventory?channel=소매|도매
//  채널별 현재고·소진 속도로 안전재고·권장 생산량 = max(0, 안전재고 − 현재고) 계산.
//  channel 미지정 = 전체(레거시).

export async function GET(req: NextRequest) {
  try {
    const cq = req.nextUrl.searchParams.get("channel");
    const channel = cq === "도매" ? "도매" as const : cq === "소매" ? "소매" as const : undefined;
    const r = await getInventoryRows(channel);
    return NextResponse.json({ ok: true, configured: true, ...r });
  } catch (err) {
    console.error("[production/inventory]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
