import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/payments/unpaid
// 미입금·부분입금 발주 + 각 발주의 입금 합계
export async function GET(_req: NextRequest) {
  try {
    const sb = supabaseAdmin();

    // 1) payment_status 가 미입금/부분입금 인 발주
    const { data: orders, error: oErr } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, status, payment_status, total, " +
          "company:company_id(name)"
      )
      .in("payment_status", ["미입금", "부분입금"])
      .order("order_date", { ascending: true });
    if (oErr) throw oErr;

    const orderIds = ((orders ?? []) as unknown as { id: string }[]).map((o) => o.id);

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
      return {
        id: o.id,
        order_no: o.order_no,
        order_date: o.order_date,
        ship_date: o.ship_date,
        status: o.status,
        payment_status: o.payment_status,
        total: Number(o.total) || 0,
        paid,
        remaining: (Number(o.total) || 0) - paid,
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
