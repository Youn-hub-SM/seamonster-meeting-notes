// 붙여넣기 N~V 수식(박스타입/운임/중량 규칙) 전문 + code 조회표 추출. PII 없는 열만.
import ExcelJS from "exceljs";
import fs from "fs";

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("C:\\Users\\younh\\Downloads\\배송일지.xlsx");

  const paste = wb.getWorksheet("붙여넣기")!;
  console.log("===== 붙여넣기 헤더(N~V = 14~22열) =====");
  for (let c = 14; c <= 22; c++) {
    const h = paste.getRow(1).getCell(c).value;
    console.log(`  ${paste.getRow(1).getCell(c).address}: ${h ?? "(빈)"}`);
  }
  console.log("\n===== 붙여넣기 행3 수식 전문(N~V) =====");
  for (const r of [3, 4, 6]) {
    console.log(`--- 행${r} ---`);
    for (let c = 14; c <= 22; c++) {
      const cell = paste.getRow(r).getCell(c);
      const addr = cell.address;
      const val = cell.formula ? `=${cell.formula}` : (cell.value == null ? "" : JSON.stringify(cell.value));
      if (val) console.log(`  ${addr}: ${val}`);
    }
  }

  const code = wb.getWorksheet("code")!;
  console.log(`\n===== code 시트 ${code.rowCount}행 · 헤더 =====`);
  for (let c = 1; c <= 6; c++) console.log(`  ${code.getRow(1).getCell(c).address}: ${code.getRow(1).getCell(c).value ?? ""}`);
  // 전체 덤프 → JSON
  const rows: { sku: string; pkgW: unknown; unitCnt: unknown; totalW: unknown; name: string }[] = [];
  for (let r = 2; r <= code.rowCount; r++) {
    const sku = String(code.getRow(r).getCell(1).value ?? "").trim();
    if (!sku) continue;
    rows.push({
      sku,
      pkgW: code.getRow(r).getCell(2).value,
      unitCnt: code.getRow(r).getCell(3).value,
      totalW: code.getRow(r).getCell(4).value,
      name: String(code.getRow(r).getCell(5).value ?? ""),
    });
  }
  const out = "C:\\Users\\younh\\AppData\\Local\\Temp\\claude\\C--Users-younh-Desktop-claude\\79704dc2-0617-44b3-8592-50308a510654\\scratchpad\\code-table.json";
  fs.writeFileSync(out, JSON.stringify(rows, null, 0), "utf8");
  console.log(`\ncode 유효행 ${rows.length}개 → ${out}`);
  console.log("샘플 10개(중량/이름 확인):");
  for (const x of rows.slice(0, 10)) console.log(`  ${x.sku} | 포장중량 ${x.pkgW} | 단품수 ${x.unitCnt} | 총중량 ${x.totalW} | 이름="${x.name.replace(/\s+/g, " ").slice(0, 45)}"`);
  // 중량 분포(박스타입 구간 이해용)
  const ws = rows.map((x) => Number(x.totalW) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  console.log(`\n총중량(D) 분포: 최소 ${ws[0]} · 최대 ${ws[ws.length - 1]} · 개수 ${ws.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
