import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005 } from "@/app/lib/factory-db";
import { FACTORY_XLSX_HEADERS, factoryProductToRow } from "@/app/lib/factory-product-xlsx";
import type { FactoryProduct } from "@/app/lib/factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 파도소리 상품마스터 전 품목(재고관리 사용안함 포함)을 엑셀로(관리자). ID 포함 → 고쳐서 다시 올리면 된다(씨몬스터 상품 마스터와 같은 방식).
//  품목이 없으면 헤더만 있는 양식이 내려간다.
export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "관리자만 내려받을 수 있습니다." }, { status: 403 });
    const { data, error } = await factoryDb().from("products").select("*")
      .order("stock_tracked", { ascending: false }).order("name").order("sku");
    if (error) throw error;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("상품마스터");
    ws.addRow([...FACTORY_XLSX_HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    for (const p of (data || []) as FactoryProduct[]) {
      const row = factoryProductToRow(p);
      ws.addRow(FACTORY_XLSX_HEADERS.map((h) => row[h] ?? ""));
    }
    ws.columns.forEach((c, i) => {
      const h = FACTORY_XLSX_HEADERS[i];
      c.width = h === "ID" ? 38 : h === "품목" || h === "비고" ? 24 : h === "재고관리(Y/N)" ? 14 : 12;
    });
    // ID 는 매칭 키 — 고치지 않는다. 신규는 ID 칸을 비운다.

    const buf = await wb.xlsx.writeBuffer();
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="padosori-product-master-${today}.xlsx"`,
      },
    });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    console.error("[factory/products export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "추출 실패") }, { status: 500 });
  }
}
