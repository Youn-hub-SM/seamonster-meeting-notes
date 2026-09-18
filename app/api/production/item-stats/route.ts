import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getInventoryRows } from "@/app/lib/production-inventory";
import { getLedgerVelocity } from "@/app/lib/production-velocity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/production/item-stats
// 생산일정 추가 모달용 — 품목별 현재고·일평균출고(최근 한달)·예상 재고소진일수 +
//  안전재고·대기수요·안전재고 도달일수(권장 생산량 산정용).
//  (소진일/안전재고 도달일 날짜는 클라이언트가 오늘 + 일수로 계산)

export async function GET() {
  try {
    const [inv, velocity] = await Promise.all([getInventoryRows(), getLedgerVelocity()]);

    const items = inv.rows
      .filter((r) => r.inBoxhero)
      .map((r) => {
        const dailyOut = velocity.perSku[r.sku] || 0;
        const depletionDays =
          dailyOut > 0 && r.stock != null ? Math.max(0, Math.floor(r.stock / dailyOut)) : null;
        return {
          sku: r.sku,
          name: r.name,
          stock: r.stock,
          dailyOut: Math.round(dailyOut * 10) / 10,
          depletionDays,
          // 권장 생산량(보수적) 산정용 — 안전재고·대기수요·안전재고 도달일수
          safety: r.safety,
          demand: r.demand,
          autoSafety: r.autoSafety,
          safetyDays: r.requestByDays,   // 현재고가 안전재고로 내려가는 남은 일수(null=출고0/재고없음)
          belowSafety: r.belowSafety,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));

    return NextResponse.json({
      ok: true,
      configured: true,
      items,
      leadDays: inv.leadDays,
      velocitySpanDays: velocity.spanDays,
    });
  } catch (err) {
    console.error("[production/item-stats]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
