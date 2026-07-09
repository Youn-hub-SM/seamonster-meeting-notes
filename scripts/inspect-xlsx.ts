// 물류양식.xlsx 구조 확인용(입력 열 파악). PII 가능 → 커밋 금지, 콘솔만.
import ExcelJS from "exceljs";

async function main() {
  const path = process.argv[2] || "C:\\Users\\younh\\Downloads\\물류양식.xlsx";
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  console.log(`파일: ${path}`);
  console.log(`시트 ${wb.worksheets.length}개: ${wb.worksheets.map((w) => w.name).join(" · ")}\n`);

  for (const ws of wb.worksheets) {
    console.log(`===== 시트 "${ws.name}" — ${ws.rowCount}행 x ${ws.columnCount}열 =====`);
    const maxRows = Math.min(ws.rowCount, 6);
    const maxCols = Math.min(Math.max(ws.columnCount, 13), 20);
    for (let r = 1; r <= maxRows; r++) {
      const cells: string[] = [];
      let hasFormula = false;
      for (let c = 1; c <= maxCols; c++) {
        const cell = ws.getRow(r).getCell(c);
        const colLetter = cell.address.replace(/\d+/g, "");
        let v = "";
        if (cell.formula) { v = `=${cell.formula}`; hasFormula = true; }
        else { const t = cell.value; v = t == null ? "" : (typeof t === "object" ? JSON.stringify(t) : String(t)); }
        if (v !== "") cells.push(`${colLetter}:${v.slice(0, 40)}`);
      }
      console.log(`  [행${r}${hasFormula ? " ★수식" : ""}] ${cells.join(" | ") || "(빈 행)"}`);
    }
    console.log("");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
