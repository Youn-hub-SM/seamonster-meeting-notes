import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { computeQuote } from "@/app/lib/inventory-quote";
import { fetchQuoteTxns, validMonth } from "../fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MONEY = "#,##0";
const BOLD = { bold: true } as const;
const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
const SUM_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4E5" } };

// GET /api/inventory/quote/export?month=YYYY-MM&rent=&etc= — 월간 매입 결산 엑셀(결산 시트 + raw 시트).
export async function GET(req: NextRequest) {
  try {
    const month = validMonth(req.nextUrl.searchParams.get("month"));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const rent = Number(req.nextUrl.searchParams.get("rent")) || 0;
    const exemptEtc = Number(req.nextUrl.searchParams.get("etc")) || 0;
    const taxableEtc = Number(req.nextUrl.searchParams.get("tax_etc")) || 0;

    const txns = await fetchQuoteTxns(month);
    const hasStatus = txns.some((t) => t.status != null);
    const used = hasStatus ? txns.filter((t) => t.status === "완료") : txns;
    const { items, raw, summary } = computeQuote(month, used, { rent, exemptEtc, taxableEtc });
    const [y, m] = month.split("-");
    const title = `${y}년 ${m}월`;

    const wb = new ExcelJS.Workbook();

    // ── 시트1: 매입 결산 ──
    const ws = wb.addWorksheet("매입 결산");
    ws.mergeCells("A1:H1");
    ws.getCell("A1").value = `${title} 매입 결산`;
    ws.getCell("A1").font = { bold: true, size: 14 };

    // 요약 블록 (구분 | 공급가액 | 세액/기타 | 총액)
    const sumHeader = ws.addRow(["구분", "공급가액", "세액/기타", "총액", "", "총 입금액", "", ""]);
    sumHeader.font = BOLD; sumHeader.eachCell((c) => (c.fill = HEAD_FILL));
    ws.mergeCells(`F${sumHeader.number}:H${sumHeader.number}`);
    const rRent = ws.addRow(["임대료", summary.rentSupply, summary.rentVat, summary.rentTotal, "", summary.deposit, "", ""]);
    const rExempt = ws.addRow(["면세품목", summary.exemptSupply, summary.exemptEtc, summary.exemptTotal, "", "", "", ""]);
    const rTax = ws.addRow(["과세품목", summary.taxableSupply, summary.taxableVat, summary.taxableTotal, "", "", "", ""]);
    ws.mergeCells(`F${rRent.number}:H${rTax.number}`); // 총 입금액 값 영역 병합
    const depCell = ws.getCell(`F${rRent.number}`);
    depCell.value = summary.deposit; depCell.font = { bold: true, size: 13 };
    depCell.alignment = { vertical: "middle", horizontal: "center" };
    for (const r of [rRent, rExempt, rTax]) {
      r.getCell(1).font = BOLD;
      [2, 3, 4].forEach((c) => (r.getCell(c).numFmt = MONEY));
    }
    ws.addRow([]);

    // 품목 표
    const HEAD = ["코드명", "품목명", "규격(g)", "원산지", "매입수량", "매입가", "총 매입금액", "검증", "구분"];
    const hr = ws.addRow(HEAD);
    hr.font = BOLD; hr.eachCell((c) => (c.fill = HEAD_FILL));
    for (const it of items) {
      const row = ws.addRow([
        it.sku || "", it.name, it.spec || "", it.origin || "",
        it.qty, it.unit_price, it.total,
        it.match, it.tax_type === "exempt" ? "면세" : "과세",
      ]);
      row.getCell(5).numFmt = MONEY; row.getCell(6).numFmt = MONEY; row.getCell(7).numFmt = MONEY;
      if (it.match === "다름") row.getCell(8).font = { color: { argb: "FFC0392B" }, bold: true };
    }
    const totalRow = ws.addRow(["합계", "", "", "", summary.totalQty, "", summary.totalAmount, "", ""]);
    totalRow.font = BOLD; totalRow.eachCell((c) => (c.fill = SUM_FILL));
    totalRow.getCell(5).numFmt = MONEY; totalRow.getCell(7).numFmt = MONEY;

    ws.columns.forEach((c, i) => { c.width = i === 0 ? 16 : i === 1 ? 22 : i === 3 ? 10 : 13; });

    // ── 시트2: raw (원본 입고 라인) ──
    const rs = wb.addWorksheet("raw");
    const RHEAD = ["주문번호", "상태", "거래처", "일자", "SKU", "제품명", "수량", "단가", "금액"];
    rs.addRow(RHEAD);
    rs.getRow(1).font = BOLD; rs.getRow(1).eachCell((c) => (c.fill = HEAD_FILL));
    for (const r of raw) {
      const row = rs.addRow([r.order_no || "", r.status || "", r.partner || "", r.txn_date, r.sku || "", r.name, r.qty, r.unit_amount ?? "", r.amount]);
      row.getCell(7).numFmt = MONEY; row.getCell(8).numFmt = MONEY; row.getCell(9).numFmt = MONEY;
    }
    rs.columns.forEach((c, i) => { c.width = i === 5 ? 22 : i === 0 || i === 2 ? 14 : 11; });

    const buf = await wb.xlsx.writeBuffer();
    const fname = encodeURIComponent(`씨몬스터_매입결산_${month}.xlsx`);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[inventory/quote export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "엑셀 생성 실패") }, { status: 500 });
  }
}
