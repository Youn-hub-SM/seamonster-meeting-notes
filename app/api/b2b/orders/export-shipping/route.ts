import { NextRequest, NextResponse } from "next/server";
import path from "path";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs"; // fs 접근 + ExcelJS 사용
export const dynamic = "force-dynamic";

// 발송요청 양식 셀 매핑 (시트 '주소', 데이터는 2행부터)
//   E = 상품명 / F = 옵션 / G = 수량
//   L = 수령인명 / M = 수령인연락처1
//   Q = 배송지주소 / S = 배송메세지
// 숨김 컬럼(A,B,C,H,I,J,K,N,O,P,T) 은 절대 손대지 말 것.

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "shipping-request.xlsx");
const SHEET_NAME = "주소";

// 한 행 = 한 상품 라인
type OutRow = {
  sortKey: string;       // 출력 정렬용 (발송예정일)
  product: string;
  option: string;
  qty: number;
  recipientName: string;
  recipientPhone: string;
  address: string;
  memo: string;
};

type CompanyJoin = { name?: string; contact_name?: string; contact_phone?: string; address?: string };
type ItemJoin = { product_name: string; option_label: string | null; spec: string | null; qty: number; sort_order: number };
type ShipItemJoin = { product_name: string; spec: string | null; qty: number };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { shipment_ids?: string[]; order_ids?: string[] };
    const shipmentIds = (body.shipment_ids ?? []).filter(Boolean);
    const orderIds = (body.order_ids ?? []).filter(Boolean);

    if (shipmentIds.length === 0 && orderIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "발송 또는 발주를 1개 이상 선택하세요." },
        { status: 400 }
      );
    }

    const sb = supabaseAdmin();
    const rows: OutRow[] = [];

    // ── A) 발송 단위 출력 (분할 발송) ──────────────────
    if (shipmentIds.length > 0) {
      const { data: shipments, error: shipErr } = await sb
        .from("shipments")
        .select(
          "id, seq, ship_date, recipient_name, recipient_phone, address, delivery_memo, " +
            "shipment_items(product_name, spec, qty), " +
            "order:order_id(order_no, " +
            "company:company_id(name, contact_name, contact_phone, address), " +
            "order_items(product_name, option_label, spec, qty, sort_order))"
        )
        .in("id", shipmentIds);
      if (shipErr) throw shipErr;

      type ShipRow = {
        id: string;
        seq: number;
        ship_date: string | null;
        recipient_name: string | null;
        recipient_phone: string | null;
        address: string | null;
        delivery_memo: string | null;
        shipment_items: ShipItemJoin[];
        order: {
          order_no: string;
          company: CompanyJoin | CompanyJoin[] | null;
          order_items: ItemJoin[];
        } | null;
      };

      for (const s of (shipments as unknown as ShipRow[] | null ?? [])) {
        const order = s.order;
        const company = Array.isArray(order?.company) ? order?.company[0] : order?.company;
        const recipientName = s.recipient_name || company?.contact_name || "(수령인 미지정)";
        const recipientPhone = s.recipient_phone || company?.contact_phone || "";
        const address = s.address || company?.address || "(주소 미입력)";
        const memo = s.delivery_memo ?? "";
        const sortKey = s.ship_date || "9999-12-31";

        const splitItems = s.shipment_items ?? [];
        if (splitItems.length > 0) {
          // 이 발송에 담긴 상품/수량만
          for (const it of splitItems) {
            rows.push({
              sortKey,
              product: it.product_name ?? "",
              option: it.spec || "",
              qty: Number(it.qty) || 0,
              recipientName,
              recipientPhone,
              address,
              memo,
            });
          }
        } else {
          // 상품 분할이 없는 발송 → 발주 전체상품으로 출력 (단일 발송/과거 데이터)
          const items = (order?.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
          for (const it of items) {
            rows.push({
              sortKey,
              product: it.product_name ?? "",
              option: it.spec || it.option_label || "",
              qty: Number(it.qty) || 0,
              recipientName,
              recipientPhone,
              address,
              memo,
            });
          }
        }
      }
    }

    // ── B) 발주 단위 출력 (발송 일정이 없는 과거 발주) ───
    if (orderIds.length > 0) {
      const { data: orders, error: ordersErr } = await sb
        .from("orders")
        .select(
          "id, order_no, ship_date, " +
            "company:company_id(name, contact_name, contact_phone, address), " +
            "order_items(product_name, option_label, spec, qty, sort_order), " +
            "shipments(recipient_name, recipient_phone, address, delivery_memo)"
        )
        .in("id", orderIds)
        .order("order_date", { ascending: true });
      if (ordersErr) throw ordersErr;

      type OrderRow = {
        order_no: string;
        ship_date: string | null;
        company: CompanyJoin | CompanyJoin[] | null;
        order_items: ItemJoin[];
        shipments: { recipient_name: string; recipient_phone: string; address: string; delivery_memo: string | null }[];
      };

      for (const o of (orders as unknown as OrderRow[] | null ?? [])) {
        const ship = o.shipments?.[0];
        const company = Array.isArray(o.company) ? o.company[0] : o.company;
        const recipientName = ship?.recipient_name || company?.contact_name || "(수령인 미지정)";
        const recipientPhone = ship?.recipient_phone || company?.contact_phone || "";
        const address = ship?.address || company?.address || "(주소 미입력)";
        const memo = ship?.delivery_memo ?? "";
        const sortKey = o.ship_date || "9999-12-31";

        const items = (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        for (const it of items) {
          rows.push({
            sortKey,
            product: it.product_name ?? "",
            option: it.spec || it.option_label || "",
            qty: Number(it.qty) || 0,
            recipientName,
            recipientPhone,
            address,
            memo,
          });
        }
      }
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "선택한 발송에 상품이 없습니다." },
        { status: 400 }
      );
    }

    // 발송예정일 순으로 정렬
    rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

    // 템플릿 로드 + 주입
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_PATH);
    const sheet = workbook.getWorksheet(SHEET_NAME);
    if (!sheet) {
      return NextResponse.json(
        { ok: false, error: `양식에서 시트 '${SHEET_NAME}' 를 찾을 수 없습니다.` },
        { status: 500 }
      );
    }

    let row = 2;
    for (const r of rows) {
      sheet.getCell(`E${row}`).value = r.product;
      sheet.getCell(`F${row}`).value = r.option;
      sheet.getCell(`G${row}`).value = r.qty;
      sheet.getCell(`L${row}`).value = r.recipientName;
      sheet.getCell(`M${row}`).value = r.recipientPhone;
      sheet.getCell(`Q${row}`).value = r.address;
      sheet.getCell(`S${row}`).value = r.memo;
      row++;
    }

    const buf = await workbook.xlsx.writeBuffer();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `shipping-request_${dateStr}.xlsx`;

    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[b2b/orders/export-shipping]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "xlsx 생성 실패") },
      { status: 500 }
    );
  }
}
