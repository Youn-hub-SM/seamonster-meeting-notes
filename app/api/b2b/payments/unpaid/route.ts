import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { cancelledDeductionByOrder } from "@/app/lib/b2b-cancel";

export const dynamic = "force-dynamic";

// GET /api/b2b/payments/unpaid
// 입금전·일부입금 발주 + 각 발주의 입금 합계.
//  취소 발주는 제외하고, 부분취소 발주는 취소 차수 감액을 청구액에서 뺀다(감사 후속).
export async function GET(_req: NextRequest) {
  try {
    const sb = supabaseAdmin();

    // 1) payment_status 가 입금전/일부입금 인 발주 — 취소 발주는 미수금이 아니다
    const { data: orders, error: oErr } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, status, payment_status, total, " +
          "company:company_id(name)"
      )
      .in("payment_status", ["입금전", "일부입금"])
      .neq("status", "취소")
      .order("order_date", { ascending: true });
    if (oErr) throw oErr;

    const orderIds = ((orders ?? []) as unknown as { id: string }[]).map((o) => o.id);
    const dedMap = await cancelledDeductionByOrder(sb, orderIds);

    // 2) 해당 발주들의 입금 합계
    let paidMap = new Map<string, number>();
    if (orderIds.length > 0) {
      const { data: pays, error: pErr } = await sb
        .from("payments")
        .select("order_id, amount")
        .in("order_id", orderIds);
      if (pErr) throw pErr;
      paidMap = new Map<string, number>();
      for (const p of pays ?? []) {
        paidMap.set(p.order_id, (paidMap.get(p.order_id) || 0) + Number(p.amount || 0));
      }
    }

    type CompanyJoin = { name?: string };
    type OrderRow = {
      id: string;
      order_no: string;
      order_date: string;
      ship_date: string | null;
      status: string;
      payment_status: string;
      total: number;
      company: CompanyJoin | CompanyJoin[] | null;
    };

    const result = ((orders ?? []) as unknown as OrderRow[]).map((o) => {
      const paid = paidMap.get(o.id) || 0;
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      // 실효 청구액 = 트리거 total(전량 기준) - 취소 차수 감액 — 매출 집계와 같은 기준
      const effTotal = Math.max(0, (Number(o.total) || 0) - (dedMap.get(o.id) || 0));
      return {
        id: o.id,
        order_no: o.order_no,
        order_date: o.order_date,
        ship_date: o.ship_date,
        status: o.status,
        payment_status: o.payment_status,
        total: effTotal,
        cancelled_deduction: dedMap.get(o.id) || 0,
        paid,
        remaining: effTotal - paid,
        company_name: company?.name ?? "(미지정)",
      };
    });

    const totalRemaining = result.reduce((s, r) => s + r.remaining, 0);
    const totalPaid = result.reduce((s, r) => s + r.paid, 0);
    const totalAmount = result.reduce((s, r) => s + r.total, 0);

    return NextResponse.json({
      ok: true,
      orders: result,
      summary: {
        order_count: result.length,
        total_amount: totalAmount,
        total_paid: totalPaid,
        total_remaining: totalRemaining,
      },
    });
  } catch (err) {
    console.error("[b2b/payments/unpaid GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
