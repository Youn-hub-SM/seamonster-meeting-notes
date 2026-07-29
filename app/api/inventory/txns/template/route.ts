import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { TXN_XLSX_HEADERS, TXN_XLSX_EXAMPLE, OUT_TXN_XLSX_HEADERS, OUT_TXN_XLSX_EXAMPLE } from "@/app/lib/inventory-xlsx";
import { templateProducts, appendExcludedNote } from "@/app/lib/inventory-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/inventory/txns/template[?type=출고][&fill=1&channel=소매|도매]
//  기본(빈 양식): 입고 = SKU·수량·단가 / 출고 = 수량·(무시)·SKU (외부 출고 파일 그대로 업로드용).
//  fill=1: 전 품목의 SKU·품목명·현재고를 채워서 내려준다 — 수량 칸만 채우면 되고, 빈 행은 업로드 때 건너뛴다.
export async function GET(req: NextRequest) {
  try {
    const isOut = req.nextUrl.searchParams.get("type") === "출고";
    const fill = req.nextUrl.searchParams.get("fill") === "1";
    const channel = req.nextUrl.searchParams.get("channel") === "도매" ? "도매" : "소매";
    const label = isOut ? "출고" : "입고";

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isOut ? "출고(판매)" : "입고(구매)");

    if (fill) {
      // 채운 양식은 유형과 무관하게 헤더 이름 기준(SKU·수량)이라 입고·출고 모두 같은 모양으로 읽힌다.
      const { rows, excludedNoSku, excludedBundles } = await templateProducts(channel);
      ws.addRow(["SKU", "품목명", `현재고(${channel})`, "수량", "단가"]);
      for (const p of rows) ws.addRow([p.sku, p.spec ? `${p.name} ${p.spec}` : p.name, p.qty, "", ""]);
      // 열 font 는 그 열의 기존 셀(헤더 포함)을 통째로 덮으므로 헤더 스타일보다 반드시 먼저 깐다.
      ws.getColumn(3).font = { color: { argb: "FF8A94A6" } }; // 참고값(현재고) — 입력칸과 구분
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
      ws.columns.forEach((c, i) => { c.width = i === 0 ? 20 : i === 1 ? 34 : 14; });
      ws.views = [{ state: "frozen", ySplit: 1 }];
      appendExcludedNote(ws, excludedNoSku, excludedBundles);
    } else {
      const headers = isOut ? OUT_TXN_XLSX_HEADERS : TXN_XLSX_HEADERS;
      const example = isOut ? OUT_TXN_XLSX_EXAMPLE : TXN_XLSX_EXAMPLE;
      ws.addRow([...headers]);
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
      for (const ex of example) ws.addRow(ex);
      ws.columns.forEach((c) => { c.width = 16; });
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = fill
      ? encodeURIComponent(`씨몬스터_${label}_양식_${channel}.xlsx`)
      : encodeURIComponent(`씨몬스터_${label}_양식.xlsx`);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[inventory/txns/template]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
