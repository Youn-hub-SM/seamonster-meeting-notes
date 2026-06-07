import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// 매출 정의:
//   - 매출 = status='발송완료' 발주의 total (ship_date 기준 기간 필터)
//   - 발주잔고 = status NOT IN ('발송완료','취소') 의 total (기간 무관)
//   - 마진 = sum( (unit_price - cost_at_order) × qty ), 발송완료 발주만
//
// 응답:
//   { summary, backlog, by_company, by_product, trend }

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const from = url.searchParams.get("from") || defaultFromIso();
    const to = url.searchParams.get("to") || todayIso();

    const sb = supabaseAdmin();

    // 1) 발송완료 발주 (기간 내, ship_date 기준)
    const { data: completed, error: cErr } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, status, total, subtotal, vat, " +
          "company:company_id(id, name), " +
          "order_items(product_name, qty, unit_price, cost_at_order, tax_type)"
      )
      .eq("status", "발송완료")
      .gte("ship_date", from)
      .lte("ship_date", to);
    if (cErr) throw cErr;

    // 2) 미발송 잔고 (전체 기간, 발송완료·취소 제외)
    const { data: backlog, error: bErr } = await sb
      .from("orders")
      .select("id, total")
      .not("status", "in", "(발송완료,취소)");
    if (bErr) throw bErr;

    // 집계
    type CompanyJoin = { id?: string; name?: string };
    type ItemJoin = {
      product_name: string;
      qty: number;
      unit_price: number;
      cost_at_order: number | null;
      tax_type: "taxable" | "exempt";
    };
    type CompletedRow = {
      id: string;
      order_no: string;
      ship_date: string | null;
      total: number;
      subtotal: number;
      vat: number;
      company: CompanyJoin | CompanyJoin[] | null;
      order_items: ItemJoin[];
    };

    const rows = (completed ?? []) as unknown as CompletedRow[];

    // 요약
    let revenue = 0;
    let revenueTaxable = 0;
    let revenueExempt = 0;
    let vatTotal = 0;
    let marginTotal = 0;

    // by_company
    const byCompanyMap = new Map<string, { company_name: string; orders: number; revenue: number; margin: number }>();
    // by_product
    const byProductMap = new Map<string, { product_name: string; qty: number; revenue: number; cost: number; margin: number }>();
    // trend by month (YYYY-MM)
    const trendMap = new Map<string, number>();

    for (const o of rows) {
      revenue += Number(o.total) || 0;
      vatTotal += Number(o.vat) || 0;

      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const companyName = company?.name || "(미지정)";
      const companyKey = company?.id || "_unknown";

      let orderMargin = 0;
      let orderTaxable = 0;
      let orderExempt = 0;

      for (const it of o.order_items ?? []) {
        const qty = Number(it.qty) || 0;
        const price = Number(it.unit_price) || 0;
        const cost = Number(it.cost_at_order) || 0;
        const lineRevenue = qty * price;
        const lineMargin = (price - cost) * qty;
        orderMargin += lineMargin;
        if (it.tax_type === "exempt") orderExempt += lineRevenue;
        else orderTaxable += lineRevenue;

        // by_product
        const p = byProductMap.get(it.product_name) ?? {
          product_name: it.product_name,
          qty: 0,
          revenue: 0,
          cost: 0,
          margin: 0,
        };
        p.qty += qty;
        p.revenue += lineRevenue;
        p.cost += cost * qty;
        p.margin += lineMargin;
        byProductMap.set(it.product_name, p);
      }

      marginTotal += orderMargin;
      revenueTaxable += orderTaxable;
      revenueExempt += orderExempt;

      // by_company
      const c = byCompanyMap.get(companyKey) ?? {
        company_name: companyName,
        orders: 0,
        revenue: 0,
        margin: 0,
      };
      c.orders += 1;
      c.revenue += Number(o.total) || 0;
      c.margin += orderMargin;
      byCompanyMap.set(companyKey, c);

      // trend (월별)
      const ym = (o.ship_date || "").slice(0, 7); // YYYY-MM
      if (ym) {
        trendMap.set(ym, (trendMap.get(ym) || 0) + (Number(o.total) || 0));
      }
    }

    const byCompany = Array.from(byCompanyMap.values()).sort((a, b) => b.revenue - a.revenue);
    const byProduct = Array.from(byProductMap.values()).sort((a, b) => b.revenue - a.revenue);
    const trend = Array.from(trendMap.entries())
      .map(([month, rev]) => ({ month, revenue: rev }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const backlogTotal = (backlog ?? []).reduce((s, o) => s + (Number(o.total) || 0), 0);

    return NextResponse.json({
      ok: true,
      period: { from, to },
      summary: {
        revenue,
        revenue_taxable: revenueTaxable,
        revenue_exempt: revenueExempt,
        vat: vatTotal,
        orders_completed: rows.length,
        avg_order_value: rows.length > 0 ? Math.round(revenue / rows.length) : 0,
        margin: marginTotal,
      },
      backlog: {
        pending_orders: (backlog ?? []).length,
        pending_total: backlogTotal,
      },
      by_company: byCompany,
      by_product: byProduct,
      trend,
    });
  } catch (err) {
    console.error("[b2b/reports]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "리포트 생성 실패") },
      { status: 500 }
    );
  }
}

// 기본값: 이번 달 1일
function defaultFromIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
