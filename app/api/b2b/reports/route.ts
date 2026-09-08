import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computeOrderMargin, seasonForDate } from "@/app/lib/b2b-margin";

export const dynamic = "force-dynamic";

// GET /api/b2b/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// 매출 정의 (발송일 기준, 2026-09-08 변경 — 발주만 하고 취소되는 건이 매출에 잡히지 않게):
//   - 매출 = '발송완료' 발주의 total (발송일 ship_date 기준 기간 필터, 발송일이 비어 있으면 발주일 폴백)
//     · 발주만 등록된 상태(발송대기)는 매출이 아니다 — 미발송 잔고에만 잡힌다.
//     · 분할발송 발주는 모든 차수가 발송완료된 시점부터 발주 전체가 집계된다(발주 단위 인식).
//   - 발주잔고 = status NOT IN ('발송완료','취소') 의 total (기간 무관, 미발송 잔량)
//   - 예상마진 = Σ 발주 단위 이익 (매출[공급가] − 제품원가 − 배송 박스 비용)
//   - by_product 마진 = Σ (unit_price − cost_at_order) × qty (배송비 제외, 제품 귀속 불가)
//
// 응답:
//   { summary, backlog, by_company, by_product, trend }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const fromRaw = url.searchParams.get("from") || "";
    const toRaw = url.searchParams.get("to") || "";
    // or() 필터 문자열에 값이 직접 들어가므로 형식 검증(잘못된 값은 기본 기간으로)
    const from = DATE_RE.test(fromRaw) ? fromRaw : defaultFromIso();
    const to = DATE_RE.test(toRaw) ? toRaw : todayIso();

    const sb = supabaseAdmin();

    // 1) 발송완료 발주 (기간 내, 발송일 기준 — 발송일이 비어 있는 옛 발주는 발주일로 폴백)
    const { data: completed, error: cErr } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, status, total, subtotal, vat, box_count, discount_amount, " +
          "company:company_id(id, name), " +
          "order_items(id, product_name, spec, qty, unit_price, cost_at_order, tax_type, product_id, product:product_id(volume_kg)), " +
          "shipments(status, shipment_items(order_item_id, qty))"
      )
      .eq("status", "발송완료")
      .or(
        `and(ship_date.gte.${from},ship_date.lte.${to}),and(ship_date.is.null,order_date.gte.${from},order_date.lte.${to})`
      );
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
      id: string;
      product_name: string;
      spec: string | null;
      qty: number;
      unit_price: number;
      cost_at_order: number | null;
      tax_type: "taxable" | "exempt";
      product_id: string | null;
      product: { volume_kg: number | null } | { volume_kg: number | null }[] | null;
    };
    type ShipmentJoin = { status: string; shipment_items: { order_item_id: string | null; qty: number }[] };
    type CompletedRow = {
      id: string;
      order_no: string;
      order_date: string;
      ship_date: string | null;
      total: number;
      subtotal: number;
      vat: number;
      box_count: number | null;
      company: CompanyJoin | CompanyJoin[] | null;
      order_items: ItemJoin[];
      shipments: ShipmentJoin[] | null;
    };

    const rows = (completed ?? []) as unknown as CompletedRow[];
    const currentMonth = new Date().getMonth() + 1;

    // 요약
    let revenue = 0;
    let revenueTaxable = 0;
    let revenueExempt = 0;
    let vatTotal = 0;
    let marginTotal = 0;
    // 원가 미입력 라인 추적 — cost_at_order 가 없으면 원가 0 으로 계산돼 예상마진이 과대 계상된다.
    //  이 경우 마진 숫자를 신뢰하지 말라는 경고를 화면에 띄우기 위해 라인 수·해당 매출을 집계.
    let costMissingLines = 0;
    let costMissingRevenue = 0;

    // by_company
    const byCompanyMap = new Map<string, { company_name: string; orders: number; revenue: number; margin: number }>();
    // by_product
    const byProductMap = new Map<string, { product_name: string; spec: string | null; qty: number; revenue: number; cost: number; margin: number }>();
    // trend by month (YYYY-MM)
    const trendMap = new Map<string, number>();

    for (const o of rows) {
      // 복수 차수 중 '취소'된 차수의 수량을 order_item 별로 집계 → 매출·마진에서 그만큼 차감.
      //  (취소 차수가 없으면 맵이 비어 유효수량=원수량 → 결과가 기존과 완전히 동일 = 회귀 없음)
      const cancelledQty = new Map<string, number>();
      for (const sh of o.shipments ?? []) {
        if (sh.status !== "취소") continue;
        for (const si of sh.shipment_items ?? []) {
          if (si.order_item_id) cancelledQty.set(si.order_item_id, (cancelledQty.get(si.order_item_id) || 0) + (Number(si.qty) || 0));
        }
      }
      const effQty = (it: ItemJoin) => Math.max(0, (Number(it.qty) || 0) - (cancelledQty.get(it.id) || 0));
      // 취소분 매출을 발주 총액에서 차감 → 부분취소 발주의 매출 과대 방지.
      //  o.total 은 부가세 포함(095 트리거: subtotal + vat - discount)이므로, 취소분도 공급가에
      //  과세 라인의 부가세(10% 반올림 — 트리거와 같은 규칙)까지 얹어 빼야 취소분 VAT 가 매출에 남지 않는다.
      let cancelledSupply = 0;
      let cancelledTaxableSupply = 0;
      for (const it of o.order_items ?? []) {
        const cq = Math.min(Number(it.qty) || 0, cancelledQty.get(it.id) || 0);
        const amt = cq * (Number(it.unit_price) || 0);
        cancelledSupply += amt;
        if (it.tax_type !== "exempt") cancelledTaxableSupply += amt;
      }
      const cancelledVat = Math.round(cancelledTaxableSupply * 0.1);
      const effectiveTotal = Math.max(0, (Number(o.total) || 0) - cancelledSupply - cancelledVat);

      revenue += effectiveTotal;
      vatTotal += Math.max(0, (Number(o.vat) || 0) - cancelledVat); // 취소분 부가세도 세액 지표에서 감액

      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const companyName = company?.name || "(미지정)";
      const companyKey = company?.id || "_unknown";

      let orderTaxable = 0;
      let orderExempt = 0;

      // 발주 단위 이익 (매출[공급가] − 제품원가 − 배송 박스 비용)
      const season = seasonForDate(o.ship_date || o.order_date, currentMonth);
      const marginLines = (o.order_items ?? []).map((it) => {
        const prod = Array.isArray(it.product) ? it.product[0] : it.product;
        return {
          unitPrice: Number(it.unit_price) || 0,
          qty: effQty(it), // 취소 차수 수량 차감
          costAtOrder: Number(it.cost_at_order) || 0,
          taxType: it.tax_type,
          volumeKg: Number(prod?.volume_kg) || 0,
        };
      });
      const orderMargin = computeOrderMargin(marginLines, Number(o.box_count) || 1, season, Number((o as { discount_amount?: number }).discount_amount) || 0).profit;

      for (const it of o.order_items ?? []) {
        const qty = effQty(it); // 취소 차수 수량 차감(취소 없으면 원수량)
        const price = Number(it.unit_price) || 0;
        const cost = Number(it.cost_at_order) || 0;
        const lineRevenue = qty * price;
        const lineMargin = (price - cost) * qty; // by_product 용 (배송비 제외)
        if (it.tax_type === "exempt") orderExempt += lineRevenue;
        else orderTaxable += lineRevenue;
        // 매출은 있는데 원가가 비어 있으면(null·0) 마진이 과대 계상됨 → 경고용 집계
        if (lineRevenue > 0 && (it.cost_at_order == null || Number(it.cost_at_order) === 0)) {
          costMissingLines += 1;
          costMissingRevenue += lineRevenue;
        }

        // by_product (품목 + 옵션 단위)
        const prodKey = `${it.product_name}\u0000${it.spec ?? ""}`;
        const p = byProductMap.get(prodKey) ?? {
          product_name: it.product_name,
          spec: it.spec ?? null,
          qty: 0,
          revenue: 0,
          cost: 0,
          margin: 0,
        };
        p.qty += qty;
        p.revenue += lineRevenue;
        p.cost += cost * qty;
        p.margin += lineMargin;
        byProductMap.set(prodKey, p);
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
      c.revenue += effectiveTotal;
      c.margin += orderMargin;
      byCompanyMap.set(companyKey, c);

      // trend (월별, 발송일 기준 — 발송일 없으면 발주일 폴백)
      const ym = (o.ship_date || o.order_date || "").slice(0, 7); // YYYY-MM
      if (ym) {
        trendMap.set(ym, (trendMap.get(ym) || 0) + effectiveTotal);
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
        margin_cost_missing_lines: costMissingLines, // 원가 미입력 라인 수(>0이면 마진 과대 경고)
        margin_cost_missing_revenue: costMissingRevenue, // 그 라인들의 매출 합
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
