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

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { order_ids?: string[] };
    const ids = (body.order_ids ?? []).filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json(
        { ok: false, error: "발주를 1개 이상 선택하세요." },
        { status: 400 }
      );
    }

    const sb = supabaseAdmin();

    // 발주 헤더 + 업체 + 라인 + 송장 모두 한 번에
    const { data: orders, error: ordersErr } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, ship_date, " +
          "company:company_id(name, contact_name, contact_phone, address), " +
          "order_items(product_name, option_label, spec, qty, sort_order), " +
          "shipments(recipient_name, recipient_phone, address, delivery_memo)"
      )
      .in("id", ids)
      .order("order_date", { ascending: true });
    if (ordersErr) throw ordersErr;

    if (!orders || orders.length === 0) {
      return NextResponse.json(
        { ok: false, error: "선택한 발주를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 템플릿 로드
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_PATH);
    const sheet = workbook.getWorksheet(SHEET_NAME);
    if (!sheet) {
      return NextResponse.json(
        { ok: false, error: `양식에서 시트 '${SHEET_NAME}' 를 찾을 수 없습니다.` },
        { status: 500 }
      );
    }

    type CompanyJoin = { name?: string; contact_name?: string; contact_phone?: string; address?: string };
    type ItemJoin = { product_name: string; option_label: string | null; spec: string | null; qty: number; sort_order: number };
    type ShipmentJoin = { recipient_name: string; recipient_phone: string; address: string; delivery_memo: string | null };
    type OrderJoin = {
      id: string;
      order_no: string;
      company: CompanyJoin | CompanyJoin[] | null;
      order_items: ItemJoin[];
      shipments: ShipmentJoin[];
    };

    let row = 2;
    for (const o of orders as unknown as OrderJoin[]) {
      // 송장 없으면 업체 주소록 정보로 대체 (담당자명·연락처·주소)
      const ship = o.shipments?.[0];
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const recipientName = ship?.recipient_name || company?.contact_name || "(수령인 미지정)";
      const recipientPhone = ship?.recipient_phone || company?.contact_phone || "";
      const address = ship?.address || company?.address || "(주소 미입력)";
      const memo = ship?.delivery_memo ?? "";

      // 라인별로 1행씩
      const items = (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      if (items.length === 0) continue;

      for (const it of items) {
        sheet.getCell(`E${row}`).value = it.product_name ?? "";
        // 옵션(F) = 통합된 옵션값(spec). 과거 데이터 호환 위해 option_label 도 폴백.
        sheet.getCell(`F${row}`).value = it.spec || it.option_label || "";
        sheet.getCell(`G${row}`).value = Number(it.qty) || 0;
        sheet.getCell(`L${row}`).value = recipientName;
        sheet.getCell(`M${row}`).value = recipientPhone;
        sheet.getCell(`Q${row}`).value = address;
        sheet.getCell(`S${row}`).value = memo;
        row++;
      }
    }

    if (row === 2) {
      return NextResponse.json(
        { ok: false, error: "선택한 발주에 라인아이템이 없습니다." },
        { status: 400 }
      );
    }

    const buf = await workbook.xlsx.writeBuffer();
    const dateStr = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
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
