import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getInventoryRows } from "@/app/lib/production-inventory";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/production/inventory
// 자체 재고원장 현재고·안전재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 합쳐
//  권장 생산량 = max(0, B2B수요 + 안전재고 − 현재고) 을 계산.

export async function GET() {
  try {
    const r = await getInventoryRows();
    return NextResponse.json({ ok: true, configured: true, ...r });
  } catch (err) {
    console.error("[production/inventory]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
