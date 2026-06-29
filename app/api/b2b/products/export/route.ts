import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { PRODUCT_XLSX_HEADERS, productToRow } from "@/app/lib/b2b-product-xlsx";
import type { Product } from "@/app/lib/b2b-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/b2b/products/export — 전 품목(미사용 포함)을 엑셀로. ID 포함 → 수정 후 재업로드(라운드트립) 가능.
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("products")
      .select("*")
      .order("active", { ascending: false })
      .order("name", { ascending: true });
    if (error) throw error;
    const products = (data ?? []) as Product[];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("상품마스터");
    ws.addRow([...PRODUCT_XLSX_HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };

    for (const p of products) {
      const row = productToRow(p);
      ws.addRow(PRODUCT_XLSX_HEADERS.map((h) => row[h] ?? ""));
    }

    // 열 너비
    ws.columns.forEach((c, i) => {
      const h = PRODUCT_XLSX_HEADERS[i];
      c.width = h === "ID" ? 38 : h === "품목명" || h === "메모" ? 22 : 12;
    });
    // 안내 행은 생략(헤더만). ID 는 매칭 키 — 수정·삭제 금지, 비우면 신규 등록.

    const buf = await wb.xlsx.writeBuffer();
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="product-master-${today}.xlsx"`,
      },
    });
  } catch (err) {
    console.error("[b2b/products export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "추출 실패") }, { status: 500 });
  }
}
