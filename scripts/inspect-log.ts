// 배송일지의 택배일지/도착보장/드라이아이스/비닐 시트 구조 + 값 파악.
import ExcelJS from "exceljs";

function cell(c: ExcelJS.Cell): string {
  const v = c.value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return String(o.result ?? "");   // 수식은 결과값
    if ("text" in o) return String(o.text ?? "");
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
  }
  return String(v);
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("C:\\Users\\younh\\Downloads\\배송일지.xlsx");
  for (const name of ["택배일지", "도착보장"]) {
    const ws = wb.getWorksheet(name)!;
    const nCol = Math.min(ws.columnCount, 34);
    console.log(`\n===== ${name} (${ws.rowCount}행 x ${ws.columnCount}열) =====`);
    for (const r of [1, 2]) {
      const cells: string[] = [];
      for (let c = 1; c <= nCol; c++) { const v = cell(ws.getRow(r).getCell(c)); if (v) cells.push(`${ws.getRow(r).getCell(c).address.replace(/\d+/g, "")}:${v.slice(0, 18)}`); }
      console.log(`[헤더${r}] ${cells.join(" | ")}`);
    }
    // 값이 있는 최근 데이터행 2개(끝에서 찾기)
    let shown = 0;
    for (let r = ws.rowCount; r >= 3 && shown < 2; r--) {
      const cells: string[] = [];
      let has = false;
      for (let c = 1; c <= nCol; c++) { const v = cell(ws.getRow(r).getCell(c)); if (v) { cells.push(`${ws.getRow(r).getCell(c).address.replace(/\d+/g, "")}:${v.slice(0, 14)}`); if (c > 2) has = true; } }
      if (has) { console.log(`[행${r}] ${cells.join(" | ")}`); shown++; }
    }
    // 운임 관련 수식 1행
    const fr = ws.getRow(3);
    const fcells: string[] = [];
    for (let c = 3; c <= 8; c++) { const f = fr.getCell(c).formula; if (f) fcells.push(`${fr.getCell(c).address.replace(/\d+/g, "")}==${f.replace(/\s+/g, " ").slice(0, 60)}`); }
    if (fcells.length) console.log(`[운임수식] ${fcells.join(" | ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
