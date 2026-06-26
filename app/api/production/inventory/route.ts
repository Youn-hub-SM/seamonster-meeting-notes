import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getBoxheroToken, BoxheroError } from "@/app/lib/boxhero";
import { getInventoryRows } from "@/app/lib/production-inventory";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/production/inventory
// 박스히어로 현재고·안전재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 합쳐
//  권장 생산량 = max(0, B2B수요 + 안전재고 − 현재고) 을 계산.

export async function GET() {
  try {
    const token = await getBoxheroToken();
    if (!token) {
      return NextResponse.json({ ok: true, configured: false, rows: [] });
    }
    try {
      const { rows, itemCount, noSkuDemand, leadDays, velocitySpanDays, velocityCapped } = await getInventoryRows(token);
      return NextResponse.json({ ok: true, configured: true, itemCount, noSkuDemand, leadDays, velocitySpanDays, velocityCapped, rows });
    } catch (e) {
      const status = e instanceof BoxheroError ? e.status : 502;
      return NextResponse.json(
        { ok: false, configured: true, error: e instanceof Error ? e.message : "박스히어로 조회 실패" },
        { status: status === 401 || status === 403 ? 400 : 502 }
      );
    }
  } catch (err) {
    console.error("[production/inventory]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
