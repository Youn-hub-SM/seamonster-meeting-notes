// 매출 원본 파일(엑셀/CSV) → 헤더 키 기반 행 객체 배열. 웹 업로드·백필 공용(서버 전용).
//  헤더 행 자동 탐지(주문일자/결제금액 포함 행). CSV는 UTF-8 가정(권장은 xlsx).
import ExcelJS from "exceljs";
import { normalizeColname } from "./sales-normalize";

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; hyperlink?: string; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (typeof o.text === "string") return o.text;
    if (o.result != null) return String(o.result);
    return "";
  }
  return String(v);
}

// 헤더 후보 행인가(정규화 후 주문일자 or 결제금액 포함).
function isHeaderRow(cells: string[]): boolean {
  const norm = new Set(cells.map(normalizeColname));
  return norm.has("주문일자") || norm.has("결제금액") || norm.has("order_date") || norm.has("subtotal_amount");
}

export type ParsedFile = { headers: string[]; rows: Record<string, unknown>[] };

export async function parseSalesFile(file: File): Promise<ParsedFile> {
  const name = (file.name || "").toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".csv") || name.endsWith(".tsv")) {
    const sep = name.endsWith(".tsv") ? "\t" : ",";
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);  // BOM 제거
    return parseDelimited(text, sep);
  }

  // 엑셀 — order_date/결제금액이 있는 첫 시트, 헤더행 자동 탐지.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  let ws = wb.worksheets.find((w) => {
    const r1 = (w.getRow(1).values as unknown[]) || [];
    return isHeaderRow(r1.map(cellStr));
  }) || wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  // 헤더행 탐지(상위 10행 중)
  let headerRowIdx = 1;
  for (let i = 1; i <= Math.min(10, ws.rowCount); i++) {
    const vals = (ws.getRow(i).values as unknown[]) || [];
    if (isHeaderRow(vals.map(cellStr))) { headerRowIdx = i; break; }
  }
  const headerVals = (ws.getRow(headerRowIdx).values as unknown[]) || [];
  const headers: string[] = [];
  for (let c = 1; c < headerVals.length; c++) headers[c] = cellStr(headerVals[c]).trim();

  const rows: Record<string, unknown>[] = [];
  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const rowVals = (ws.getRow(r).values as unknown[]) || [];
    const obj: Record<string, unknown> = {};
    let any = false;
    for (let c = 1; c < headers.length; c++) {
      const h = headers[c];
      if (!h) continue;
      const raw = rowVals[c];
      obj[h] = raw instanceof Date ? raw : cellStr(raw).trim();
      if (obj[h] !== "" && obj[h] != null) any = true;
    }
    if (any) rows.push(obj);
  }
  return { headers: headers.filter(Boolean), rows };
}

// 간단 CSV/TSV 파서(따옴표 처리 포함).
function parseDelimited(text: string, sep: string): ParsedFile {
  const lines = splitCsv(text, sep);
  if (!lines.length) return { headers: [], rows: [] };
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, lines.length); i++) { if (isHeaderRow(lines[i])) { headerIdx = i; break; } }
  const headers = lines[headerIdx].map((h) => h.trim());
  const rows: Record<string, unknown>[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i];
    if (cells.every((c) => c.trim() === "")) continue;
    const obj: Record<string, unknown> = {};
    headers.forEach((h, j) => { if (h) obj[h] = (cells[j] ?? "").trim(); });
    rows.push(obj);
  }
  return { headers: headers.filter(Boolean), rows };
}

function splitCsv(text: string, sep: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out;
}
