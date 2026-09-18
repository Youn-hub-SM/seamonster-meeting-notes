import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getOpenLoad, formatOpenLoad, type OpenLoadRow } from "@/app/lib/production-openload";
import { getLeadDays, getOpenLoadDays } from "@/app/lib/production-config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/production/openload — 열린 생산 요청서의 품목별 부하(예약·그중 나감·잔여·오는 중).
//  **읽기 전용이고, 어떤 권장 수식도 이 값을 쓰지 않는다**(1단계는 표시 전용 — docs/demand-streams-plan.md 14절).
//  화면이 현재고 셀 괄호·이동 pill·요청서 배지에 그대로 찍는다.
//  집계 실패는 ok:true + inboundOk:false 로 알린다 — 조용히 0 으로 두면 화면이 '예약 없음'으로 오독한다.

export type OpenLoadApiRow = {
  product_id: string;
  reserved: number;           // 도매 표시 예약
  reserved_consumed: number;  // 그중 나감
  reserved_effective: number; // 유효 예약(3단계부터 도매 보유에서 뺄 값)
  wholesale_remain: number;   // 도매 대량 잔여
  promo_reserved: number;
  promo_remain: number;
  inbound: number;            // 오는 중
  inbound_due: string | null;
  stale_inbound: number;      // 시한이 지나 빠진 제조사 잔여
  stale_committed: number;    // 시한이 지나 빠진 확정형 잔여
  wholesale_detail: string;   // 툴팁
  inbound_detail: string;
};

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
    const [leadDays, days] = await Promise.all([getLeadDays(), getOpenLoadDays()]);
    const load = await getOpenLoad(sb, today, { leadDays, ...days });
    if (!load) {
      return NextResponse.json({ ok: true, ok_load: false, rows: [], requests: [], meta: { today, leadDays, ...days } });
    }
    // 요청서 단위 집계 — 생산 요청 목록의 배지용(품목 행을 합쳐 요청서 하나로)
    const byReq = new Map<string, { request_id: string; req_no: string | null; purpose: string; reserved: number; consumed: number; remain: number; stale: boolean }>();
    for (const r of (load as Map<string, OpenLoadRow>).values()) {
      for (const q of r.reqs) {
        const cur = byReq.get(q.id) ?? { request_id: q.id, req_no: q.req_no, purpose: q.purpose, reserved: 0, consumed: 0, remain: 0, stale: false };
        cur.reserved = Math.round((cur.reserved + q.reserved) * 100) / 100;
        cur.consumed = Math.round((cur.consumed + q.consumed) * 100) / 100;
        cur.remain = Math.round((cur.remain + q.remain) * 100) / 100;
        cur.stale = cur.stale || q.stale;
        byReq.set(q.id, cur);
      }
    }

    const rows: OpenLoadApiRow[] = [];
    for (const [product_id, r] of load as Map<string, OpenLoadRow>) {
      if (r.reservedShown === 0 && r.wholesaleRemain === 0 && r.promoReserved === 0 && r.promoRemain === 0
        && r.inbound === 0 && r.staleInbound === 0 && r.staleCommitted === 0) continue;
      rows.push({
        product_id,
        reserved: r.reservedShown,
        reserved_consumed: r.reservedConsumed,
        reserved_effective: r.reservedEffective,
        wholesale_remain: r.wholesaleRemain,
        promo_reserved: r.promoReserved,
        promo_remain: r.promoRemain,
        inbound: r.inbound,
        inbound_due: r.inboundDue,
        stale_inbound: r.staleInbound,
        stale_committed: r.staleCommitted,
        wholesale_detail: formatOpenLoad(r, "도매 납품"),
        inbound_detail: formatOpenLoad(r, "재고 보충"),
      });
    }
    return NextResponse.json({ ok: true, ok_load: true, rows, requests: [...byReq.values()], meta: { today, leadDays, ...days } });
  } catch (err) {
    console.error("[production/openload]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서 부하 조회 실패") }, { status: 500 });
  }
}
