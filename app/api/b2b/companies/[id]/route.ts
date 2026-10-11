import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { cancelledDeductionByOrder } from "@/app/lib/b2b-cancel";
import { fetchAllPages, fetchInChunks } from "@/app/lib/sales-paging";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/b2b/companies/[id]
// 거래처 정보 + 발주 이력 + 집계(총매출·미수금·발주수·주력품목)
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();

    const { data: company, error: cErr } = await sb
      .from("companies")
      .select("*")
      .eq("id", id)
      .single();
    if (cErr) throw cErr;
    if (!company) return NextResponse.json({ ok: false, error: "거래처를 찾을 수 없습니다." }, { status: 404 });

    // 1,000행 상한 없이 끝까지(정렬 끝에 id — 페이지 경계 고정)
    const orderRows = await fetchAllPages<{
      id: string;
      order_no: string;
      order_date: string;
      ship_date: string | null;
      status: string;
      payment_status: string;
      total: number;
      order_items: { product_name: string; spec: string | null; qty: number }[];
    }>((lo, hi) =>
      sb.from("orders")
        .select("id, order_no, order_date, ship_date, status, payment_status, total, order_items(product_name, spec, qty)")
        .eq("company_id", id)
        .order("order_date", { ascending: false })
        .order("id", { ascending: false })
        .range(lo, hi), { label: "발주" });

    // 미수금 = 입금 확인 화면(/api/b2b/payments/unpaid)과 같은 규칙:
    //  입금전·일부입금 · 취소 제외 · 실효 청구액(total − 취소 차수 감액) − 입금 합
    const isUnpaid = (o: { status: string; payment_status: string }) =>
      o.status !== "취소" && (o.payment_status === "입금전" || o.payment_status === "일부입금");
    const unpaidIds = orderRows.filter(isUnpaid).map((o) => o.id);
    const dedIds = orderRows.filter((o) => isUnpaid(o) || o.status === "발송완료").map((o) => o.id);
    const dedMap = new Map<string, number>();
    for (let i = 0; i < dedIds.length; i += 100) {
      const part = await cancelledDeductionByOrder(sb, dedIds.slice(i, i + 100));
      for (const [k, v] of part) dedMap.set(k, v);
    }
    const effTotal = (o: { id: string; total: number }) => Math.max(0, (Number(o.total) || 0) - (dedMap.get(o.id) || 0));

    const paidByOrder = new Map<string, number>();
    const pays = await fetchInChunks<{ order_id: string; amount: number }>(unpaidIds, (part, lo, hi) =>
      sb.from("payments").select("id, order_id, amount").in("order_id", part).order("id").range(lo, hi));
    for (const p of pays) paidByOrder.set(p.order_id, (paidByOrder.get(p.order_id) || 0) + Number(p.amount || 0));

    let revenue = 0; // 발송완료 실효 청구액 합(부분취소 감액 반영)
    let outstanding = 0; // 미수금
    const productMap = new Map<string, { product_name: string; qty: number; orders: number }>();

    for (const o of orderRows) {
      if (o.status === "발송완료") revenue += effTotal(o);
      if (isUnpaid(o)) outstanding += effTotal(o) - (paidByOrder.get(o.id) || 0);
      const seenInThisOrder = new Set<string>();
      for (const it of o.order_items ?? []) {
        const key = it.product_name;
        const pr = productMap.get(key) ?? { product_name: key, qty: 0, orders: 0 };
        pr.qty += Number(it.qty) || 0;
        if (!seenInThisOrder.has(key)) {
          pr.orders += 1;
          seenInThisOrder.add(key);
        }
        productMap.set(key, pr);
      }
    }

    const topProducts = Array.from(productMap.values()).sort((a, b) => b.qty - a.qty).slice(0, 10);

    // 발주 목록 미리보기 (품목 요약 포함)
    const orderList = orderRows.map((o) => ({
      id: o.id,
      order_no: o.order_no,
      order_date: o.order_date,
      ship_date: o.ship_date,
      status: o.status,
      payment_status: o.payment_status,
      total: Number(o.total) || 0,
      items: (o.order_items ?? []).map((it) => ({ product_name: it.product_name, spec: it.spec, qty: Number(it.qty) || 0 })),
    }));

    return NextResponse.json({
      ok: true,
      company,
      orders: orderList,
      summary: {
        order_count: orderRows.length,
        revenue,
        outstanding,
        unpaid_count: unpaidIds.length,
      },
      top_products: topProducts,
    });
  } catch (err) {
    console.error("[b2b/companies/[id] GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
