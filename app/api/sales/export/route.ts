import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { salesOrIlike } from "@/app/lib/sales-filter";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PAGE = 1000;
const HARD_CAP = 120000; // 안전 상한(초과 시 상단 절삭 + 안내)

// 매출 원장 엑셀 추출 — 전화번호·이름은 제외(분석 컬럼만). 기간·채널·검색어 필터 지원.
export async function GET(req: NextRequest) {
  try {
    const p = new URL(req.url).searchParams;
    const from = p.get("from") || "", to = p.get("to") || "", channel = p.get("channel") || "", text = (p.get("text") || "").trim();
    const sb = supabaseAdmin();

    const cols = "order_date,channel,order_id,product_name,option_name,sku_code,quantity,selling_price,option_price,subtotal_amount,shipping_fee";
    const all: Record<string, unknown>[] = [];
    for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
      // order_date·order_id 는 유니크가 아니므로 동률행이 페이지 경계에 걸치면 OFFSET 페이징이
      //    행을 중복/누락시킴 → 유니크키 id 를 마지막 정렬키로 추가해 페이지 간 순서를 고정.
      let q = sb.from("sales_orders").select(cols)
        .order("order_date", { ascending: true }).order("order_id", { ascending: true }).order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (from) q = q.gte("order_date", from);
      if (to) q = q.lte("order_date", to);
      if (channel) q = q.eq("channel", channel);
      if (text) { const orf = salesOrIlike(text); if (orf) q = q.or(orf); }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const batch = data || [];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    // HARD_CAP 에 걸려 절삭됐는지: 상한만큼 정확히 채워지면 그 이상 행이 남아있을 수 있음.
    const truncated = all.length >= HARD_CAP;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("매출");
    ws.columns = [
      { header: "주문일자", key: "order_date", width: 12 },
      { header: "판매처", key: "channel", width: 12 },
      { header: "주문번호", key: "order_id", width: 20 },
      { header: "상품명", key: "product_name", width: 30 },
      { header: "옵션명", key: "option_name", width: 24 },
      { header: "SKU", key: "sku_code", width: 16 },
      { header: "수량", key: "quantity", width: 8 },
      { header: "판매가", key: "selling_price", width: 12 },
      { header: "옵션가", key: "option_price", width: 12 },
      { header: "결제금액", key: "subtotal_amount", width: 13 },
      { header: "배송비", key: "shipping_fee", width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D3B52" } };
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    for (const r of all) ws.addRow(r);
    for (const key of ["quantity", "selling_price", "option_price", "subtotal_amount", "shipping_fee"]) {
      ws.getColumn(key).numFmt = "#,##0";
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];

    if (truncated) {
      // 상한 초과 → 일부만 추출됨을 파일 안에서도 명확히 안내(별도 시트).
      const wa = wb.addWorksheet("안내");
      wa.getColumn(1).width = 90;
      wa.addRow([`이 파일은 안전 상한(${HARD_CAP.toLocaleString()}행)까지만 추출되었습니다. 결과가 더 많습니다.`]);
      wa.addRow(["기간·판매처·검색어로 범위를 좁혀 나눠 받으세요."]);
      wa.getRow(1).font = { bold: true, color: { argb: "FFB00020" } };
    }

    const buf = await wb.xlsx.writeBuffer();
    const stamp = `${from || "all"}_${to || "all"}`.replace(/[^0-9a-zA-Z_-]/g, "");
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sales_${stamp}.xlsx"`,
        "X-Row-Count": String(all.length),
        "X-Truncated": truncated ? "1" : "0",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
