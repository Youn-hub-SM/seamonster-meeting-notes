import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { buildOrderSalesLines, withDiscountFallback, type SalesOrderJoin } from "@/app/lib/b2b-sales-sync";
import { fetchAllPages } from "@/app/lib/sales-paging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 매출 엑셀 추출 — '발송완료' 발주(발송일 기준, 발송일 없으면 발주일 폴백)의 라인아이템을 1행씩 펼침.
//  화면 매출집계·매출원장(sales-sync)과 같은 기준: 발주만 하고 미발송인 건은 매출이 아니다.
//  order_date 컬럼(양식 고정 헤더)에는 발송일이 들어간다 — 매출원장의 주문일자와 일치.
//
// 양식 (헤더 순서 그대로):
//   channel | order_date | order_id | product_name | option_name | sku_code |
//   quantity | selling_price | option_price | subtotal_amount | shipping_fee |
//   customer_name | customer_phone

const COLUMNS = [
  "channel",
  "order_date",
  "order_id",
  "product_name",
  "option_name",
  "sku_code",
  "quantity",
  "selling_price",
  "option_price",
  "subtotal_amount",
  "shipping_fee",
  "customer_name",
  "customer_phone",
];

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) {
      return NextResponse.json(
        { ok: false, error: "from / to 파라미터 필수" },
        { status: 400 }
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json(
        { ok: false, error: "from / to 는 YYYY-MM-DD 형식이어야 합니다" },
        { status: 400 }
      );
    }

    const sb = supabaseAdmin();

    // 발송완료 발주(발송일 기준, 발송일 없으면 발주일 폴백) + 업체 + 라인(+제품 sku) — 1,000행 상한 없이 끝까지
    type CompanyJoin = { name?: string; contact_phone?: string };
    type OrderRow = SalesOrderJoin & { company: CompanyJoin | CompanyJoin[] | null };
    const orders = await withDiscountFallback((cols) =>
      fetchAllPages<OrderRow>((lo, hi) =>
        sb.from("orders")
          .select(`${cols}, company:company_id(name, contact_phone)`)
          .eq("status", "발송완료")
          .or(`and(ship_date.gte.${from},ship_date.lte.${to}),and(ship_date.is.null,order_date.gte.${from},order_date.lte.${to})`)
          .order("id")
          .range(lo, hi), { cap: 20000, label: "발주" }));

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("매출");

    // 헤더 행
    sheet.addRow(COLUMNS);
    sheet.getRow(1).font = { bold: true };

    // 정렬은 기입되는 날짜(발송일, 폴백 발주일) 기준으로 — 같은 날은 주문번호 순
    const sorted = orders
      .slice()
      .sort((a, b) => (a.ship_date || a.order_date || "").localeCompare(b.ship_date || b.order_date || "") || (a.order_no || "").localeCompare(b.order_no || ""));

    for (const o of sorted) {
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const customerName = company?.name ?? "";
      const customerPhone = company?.contact_phone ?? "";
      const orderDateYmd = (o.ship_date || o.order_date || "").replace(/-/g, ""); // 발송일(폴백 발주일) YYYY-MM-DD → YYYYMMDD

      // 매출원장(b2b-sales-sync)과 같은 라인 계산 — 취소 차수 감액·동일 라인 병합·VAT·할인 배분이 같아 subtotal_amount 합 = 원장 합
      for (const l of buildOrderSalesLines(o)) {
        sheet.addRow([
          "도매",
          orderDateYmd,
          o.order_no,
          l.product_name,
          l.option_name,
          l.sku,
          l.qty,
          l.price,
          0,                  // option_price (모델에 없음)
          l.paid,             // subtotal_amount = 할인/추가금 비례 배분 후 결제금액(부가세 포함)
          0,                  // shipping_fee (모델에 없음)
          customerName,
          customerPhone,
        ]);
      }
    }

    // 컬럼 너비 자동 — 헤더 글자 수 + 여유
    sheet.columns.forEach((col, i) => {
      const header = COLUMNS[i] ?? "";
      col.width = Math.max(12, header.length + 2);
    });

    const buf = await wb.xlsx.writeBuffer();
    const filename = `sales_${from.replace(/-/g, "")}_${to.replace(/-/g, "")}.xlsx`;

    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[b2b/reports/export]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "xlsx 생성 실패") },
      { status: 500 }
    );
  }
}
