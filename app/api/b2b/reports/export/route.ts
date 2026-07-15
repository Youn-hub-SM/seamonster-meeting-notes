import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 매출 엑셀 추출 — 취소 제외 발주(발주일 기준)의 라인아이템을 1행씩 펼침.
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

    const sb = supabaseAdmin();

    // 취소 제외 발주(발주일 기준) + 업체 + 라인(+제품 sku)
    const { data: orders, error } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, status, " +
          "company:company_id(name, contact_phone), " +
          "order_items(id, product_name, option_label, spec, qty, unit_price, sort_order, " +
            "product:product_id(sku)), " +
          "shipments(status, shipment_items(order_item_id, qty))"
      )
      .neq("status", "취소")
      .gte("order_date", from)
      .lte("order_date", to)
      .order("order_date", { ascending: true });
    if (error) throw error;

    type CompanyJoin = { name?: string; contact_phone?: string };
    type ProductJoin = { sku?: string | null };
    type ItemJoin = {
      id: string;
      product_name: string;
      option_label: string | null;
      spec: string | null;
      qty: number;
      unit_price: number;
      sort_order: number;
      product?: ProductJoin | ProductJoin[] | null;
    };
    type ShipmentJoin = { status: string; shipment_items: { order_item_id: string | null; qty: number }[] };
    type OrderRow = {
      order_no: string;
      order_date: string;
      company: CompanyJoin | CompanyJoin[] | null;
      order_items: ItemJoin[];
      shipments: ShipmentJoin[] | null;
    };

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("매출");

    // 헤더 행
    sheet.addRow(COLUMNS);
    sheet.getRow(1).font = { bold: true };

    for (const o of (orders ?? []) as unknown as OrderRow[]) {
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const customerName = company?.name ?? "";
      const customerPhone = company?.contact_phone ?? "";
      const orderDateYmd = (o.order_date ?? "").replace(/-/g, ""); // YYYY-MM-DD → YYYYMMDD

      // 복수 차수 중 '취소'된 차수의 수량을 order_item 별로 집계 → 유효수량에서 차감(화면 리포트와 동일 기준).
      const cancelledQty = new Map<string, number>();
      for (const sh of o.shipments ?? []) {
        if (sh.status !== "취소") continue;
        for (const si of sh.shipment_items ?? []) {
          if (si.order_item_id) cancelledQty.set(si.order_item_id, (cancelledQty.get(si.order_item_id) || 0) + (Number(si.qty) || 0));
        }
      }

      const items = (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      for (const it of items) {
        const product = Array.isArray(it.product) ? it.product[0] : it.product;
        const sku = product?.sku ?? "";
        const qty = Math.max(0, (Number(it.qty) || 0) - (cancelledQty.get(it.id) || 0)); // 취소 차수 수량 차감
        if (qty === 0) continue; // 전량 취소된 라인은 매출 0 → 행 제외
        const price = Number(it.unit_price) || 0;
        sheet.addRow([
          "도매",
          orderDateYmd,
          o.order_no,
          it.product_name ?? "",
          it.spec || it.option_label || "",   // option_name = 통합 옵션값(spec)
          sku,
          qty,
          price,
          0,                  // option_price (모델에 없음)
          qty * price,        // subtotal_amount
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
