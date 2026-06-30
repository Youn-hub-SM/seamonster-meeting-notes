import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { buildManufacturerReport, MFG_FAULT } from "@/app/lib/voc-manufacturer";
import type { Voc } from "@/app/lib/voc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MONTH_RE = /^\d{4}-\d{2}$/;
const MONEY = "#,##0";
const BOLD = { bold: true } as const;
const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
const SUM_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4E5" } };

// GET /api/voc/manufacturer/export?month=YYYY-MM&recipient= — 월간 제조사 VOC 공유자료 엑셀.
export async function GET(req: NextRequest) {
  try {
    const month = req.nextUrl.searchParams.get("month");
    if (!month || !MONTH_RE.test(month)) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const recipient = (req.nextUrl.searchParams.get("recipient") || "").slice(0, 100);
    const from = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const to = new Date(y, m, 0).toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin()
      .from("voc")
      .select("*")
      .eq("fault", MFG_FAULT)
      .neq("source", "설문") // 설문(Tally)은 클레임 아님 — 페이지(/api/voc)와 동일 제외
      .gte("received_at", from)
      .lte("received_at", to)
      .order("received_at", { ascending: true });
    if (error) throw error;

    const report = buildManufacturerReport((data ?? []) as Voc[], month);
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    const wb = new ExcelJS.Workbook();

    // ── 시트1: 제품별 집계 + 요약 ──
    const ws = wb.addWorksheet("제품별 집계");
    ws.mergeCells("A1:D1");
    ws.getCell("A1").value = `${y}년 ${m}월 제조사 VOC 공유자료`;
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.addRow([`작성일 ${today}`, recipient ? `수신 ${recipient}` : "", "대상 = 제조사 귀책", ""]);
    ws.addRow([`총 ${report.summary.count}건`, `청구 가능 손해액 ${report.summary.claimable.toLocaleString()}원`, `대상 제품 ${report.summary.productCount}종`, ""]);
    ws.addRow([]);

    const HEAD = ["제품", "건수", "주요 유형", "청구 손해액(원)"];
    const hr = ws.addRow(HEAD);
    hr.font = BOLD; hr.eachCell((c) => (c.fill = HEAD_FILL));
    for (const p of report.byProduct) {
      const row = ws.addRow([p.product, p.count, p.categories.map(([c, n]) => `${c} ${n}`).join(" · "), p.claimable]);
      row.getCell(2).numFmt = MONEY; row.getCell(4).numFmt = MONEY;
    }
    const sumRow = ws.addRow(["합계", report.summary.count, "", report.summary.claimable]);
    sumRow.font = BOLD; sumRow.eachCell((c) => (c.fill = SUM_FILL));
    sumRow.getCell(2).numFmt = MONEY; sumRow.getCell(4).numFmt = MONEY;
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 24 : i === 2 ? 28 : 14; });

    // ── 시트2: 접수 상세 ──
    const ds = wb.addWorksheet("접수 상세");
    const DHEAD = ["접수일", "제품", "생산일", "유형", "내용", "원인", "처리내용", "손해(원)", "사진"];
    ds.addRow(DHEAD);
    ds.getRow(1).font = BOLD; ds.getRow(1).eachCell((c) => (c.fill = HEAD_FILL));
    for (const r of report.items) {
      const row = ds.addRow([
        r.received_at || "", r.product || "", r.production_date || "", r.category,
        r.content || "", r.cause || "", r.resolution || "", r.loss_amount || 0, (r.photos || []).join("\n"),
      ]);
      row.getCell(8).numFmt = MONEY;
      row.alignment = { vertical: "top", wrapText: true };
    }
    ds.columns.forEach((c, i) => { c.width = [12, 18, 12, 8, 40, 28, 28, 12, 30][i] || 14; });

    const buf = await wb.xlsx.writeBuffer();
    const fname = encodeURIComponent(`씨몬스터_제조사VOC_${month}.xlsx`);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[voc/manufacturer export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "엑셀 생성 실패") }, { status: 500 });
  }
}
