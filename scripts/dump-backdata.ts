import ExcelJS from "exceljs";
const num = (v: any) => (v && typeof v === "object" && "result" in v ? v.result : v);
async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("C:/Users/younh/Desktop/claude/파이썬/이익률계산기/이익률계산백데이터.xlsx");
  const pack = wb.getWorksheet("택배포장")!;
  const pairs: [number, number][] = [];
  pack.eachRow((row, i) => { if (i > 1) { const w = num((row.values as any[])[1]); const t = num((row.values as any[])[6]); if (w != null && t != null) pairs.push([Number(w), Number(t)]); } });
  console.log(`택배포장 행수=${pairs.length}, 중량 ${pairs[0][0]}~${pairs[pairs.length-1][0]}`);
  console.log("PAIRS=" + JSON.stringify(pairs));
  // 계단 변화점만
  console.log("\n총액 변화점:");
  let prev = -1;
  for (const [w, t] of pairs) { if (t !== prev) { console.log(`  중량 ${w} 이상 → ${t}원`); prev = t; } }
  // 시트0 구조
  const s0 = wb.worksheets[0];
  console.log(`\n시트0(${s0.name}) 헤더: ${JSON.stringify(s0.getRow(1).values)}`);
  for (let i = 2; i <= 4; i++) console.log("  " + JSON.stringify(s0.getRow(i).values));
}
main().catch((e) => { console.error(e); process.exit(1); });
