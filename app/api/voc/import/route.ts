import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { VOC_XLSX_HEADERS, cellStr, parseVocRow, type VocImportRow } from "@/app/lib/voc-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/voc/import (multipart file) — 엑셀 파싱 → 미리보기 { summary, rows, errors }.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });

    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    const headerRow = ws.getRow(1);
    const col = new Map<string, number>();
    headerRow.eachCell((cell, c) => col.set(cellStr(cell.value), c));
    if (!col.has("접수일") || !col.has("상세내용")) {
      return NextResponse.json({ ok: false, error: "헤더에 '접수일'·'상세내용'이 필요합니다. (양식을 받아 사용하세요)" }, { status: 400 });
    }

    const rows: VocImportRow[] = [];
    const errors: { line: number; msg: string }[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const { row: parsed, err } = parseVocRow(get);
      if (err) { errors.push({ line: r, msg: err }); continue; }
      if (parsed) rows.push(parsed);
    }
    return NextResponse.json({ ok: true, summary: { valid: rows.length, errors: errors.length }, rows, errors, headers: VOC_XLSX_HEADERS });
  } catch (err) {
    console.error("[voc/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
