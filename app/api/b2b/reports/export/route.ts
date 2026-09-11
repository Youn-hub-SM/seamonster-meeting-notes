import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

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

    // 발송완료 발주(발송일 기준, 발송일 없으면 발주일 폴백) + 업체 + 라인(+제품 sku)
    const { data: orders, error } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, status, discount_amount, " +
          "company:company_id(name, contact_phone), " +
          "order_items(id, product_name, option_label, spec, qty, unit_price, sort_order, tax_type, " +
            "product:product_id(sku)), " +
          "shipments(status, shipment_items(order_item_id, qty))"
      )
      .eq("status", "발송완료")
      .or(
        `and(ship_date.gte.${from},ship_date.lte.${to}),and(ship_date.is.null,order_date.gte.${from},order_date.lte.${to})`
      )
      .order("ship_date", { ascending: true });
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
      tax_type?: string | null;
      product?: ProductJoin | ProductJoin[] | null;
    };
    type ShipmentJoin = { status: string; shipment_items: { order_item_id: string | null; qty: number }[] };
    type OrderRow = {
      order_no: string;
      order_date: string;
      ship_date: string | null;
      discount_amount?: number | null;
      company: CompanyJoin | CompanyJoin[] | null;
      order_items: ItemJoin[];
      shipments: ShipmentJoin[] | null;
    };

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("매출");

    // 헤더 행
    sheet.addRow(COLUMNS);
    sheet.getRow(1).font = { bold: true };

    // 정렬은 기입되는 날짜(발송일, 폴백 발주일) 기준으로 — DB 정렬(ship_date)은 null 행을 끝으로 밀어
    //  폴백 행이 기간 초 날짜를 달고 파일 끝에 나오는 문제가 있다.
    const sorted = ((orders ?? []) as unknown as OrderRow[])
      .slice()
      .sort((a, b) => ((a.ship_date || a.order_date || "") < (b.ship_date || b.order_date || "") ? -1 : 1));

    for (const o of sorted) {
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const customerName = company?.name ?? "";
      const customerPhone = company?.contact_phone ?? "";
      const orderDateYmd = (o.ship_date || o.order_date || "").replace(/-/g, ""); // 발송일(폴백 발주일) YYYY-MM-DD → YYYYMMDD

      // 복수 차수 중 '취소'된 차수의 수량을 order_item 별로 집계 → 유효수량에서 차감(화면 리포트와 동일 기준).
      const cancelledQty = new Map<string, number>();
      for (const sh of o.shipments ?? []) {
        if (sh.status !== "취소") continue;
        for (const si of sh.shipment_items ?? []) {
          if (si.order_item_id) cancelledQty.set(si.order_item_id, (cancelledQty.get(si.order_item_id) || 0) + (Number(si.qty) || 0));
        }
      }

      const items = (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      // 유효 라인(취소 차수 수량 차감, 전량 취소 제외) 수집 후 할인/추가금을 비례 배분 —
      //  매출원장(b2b-sales-sync)과 같은 규칙이라 subtotal_amount 합 = 원장 결제금액 합이 성립한다.
      //  (양수 = 할인 차감, 음수 = 추가금 가산. 마지막 라인이 반올림 오차를 흡수)
      const lines: { name: string; option: string; sku: string; qty: number; price: number; taxable: boolean }[] = [];
      for (const it of items) {
        const product = Array.isArray(it.product) ? it.product[0] : it.product;
        const qty = Math.max(0, (Number(it.qty) || 0) - (cancelledQty.get(it.id) || 0)); // 취소 차수 수량 차감
        if (qty === 0) continue; // 전량 취소된 라인은 매출 0 → 행 제외
        lines.push({
          name: it.product_name ?? "",
          option: it.spec || it.option_label || "",   // option_name = 통합 옵션값(spec)
          sku: product?.sku ?? "",
          qty,
          price: Number(it.unit_price) || 0,
          taxable: it.tax_type !== "exempt",
        });
      }
      // 결제금액은 부가세 포함 — 원장·화면 매출집계와 동일 기준(감사 후속: 도매만 공급가면 VAT 만큼 갈라짐).
      //  VAT 는 발주 단위 1회 반올림 후 마지막 과세 라인이 오차 흡수(095 트리거·명세표·원장 sync 와 동일 규칙).
      const supplyOf = (l: { qty: number; price: number }) => l.qty * l.price;
      const taxableSupply = lines.reduce((s, l) => s + (l.taxable ? supplyOf(l) : 0), 0);
      const orderVat = Math.round(taxableSupply * 0.1);
      const vatOf: number[] = [];
      {
        let vatAcc = 0;
        const lastTaxable = lines.map((l) => l.taxable).lastIndexOf(true);
        lines.forEach((l, i) => {
          if (!l.taxable) { vatOf.push(0); return; }
          const v = i === lastTaxable ? orderVat - vatAcc : Math.round(supplyOf(l) * 0.1);
          vatOf.push(v);
          vatAcc += v;
        });
      }
      const lineAmt = (l: { qty: number; price: number; taxable: boolean }, i: number) => supplyOf(l) + (vatOf[i] || 0);
      const gross = lines.reduce((s, l, i) => s + lineAmt(l, i), 0);
      const disc = Math.min(Number(o.discount_amount) || 0, gross); // 할인은 gross 상한, 음수(추가금)는 통과
      let allocated = 0;
      lines.forEach((l, i) => {
        const line = lineAmt(l, i);
        const paid = i === lines.length - 1
          ? gross - disc - allocated
          : Math.round(line * (gross > 0 ? 1 - disc / gross : 1));
        allocated += paid;
        sheet.addRow([
          "도매",
          orderDateYmd,
          o.order_no,
          l.name,
          l.option,
          l.sku,
          l.qty,
          l.price,
          0,                  // option_price (모델에 없음)
          paid,               // subtotal_amount = 할인/추가금 비례 배분 후 결제금액
          0,                  // shipping_fee (모델에 없음)
          customerName,
          customerPhone,
        ]);
      });
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
