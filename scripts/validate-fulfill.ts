import ExcelJS from "exceljs";
import fs from "fs";
import { buildCnplus, type CodeInfo } from "../app/lib/order-fulfill";

async function main() {
  // 코드표
  const codeRows = JSON.parse(fs.readFileSync("C:\\Users\\younh\\AppData\\Local\\Temp\\claude\\C--Users-younh-Desktop-claude\\79704dc2-0617-44b3-8592-50308a510654\\scratchpad\\code-table.json", "utf8")) as { sku: string; totalW: unknown; name: string }[];
  const codeMap = new Map<string, CodeInfo>();
  for (const c of codeRows) codeMap.set(String(c.sku).trim().toUpperCase(), { courier_name: String(c.name || ""), order_weight: Number(c.totalW) || 0 });

  // 입력 물류양식(A~M), 헤더 1행 제외
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("C:\\Users\\younh\\Downloads\\물류양식.xlsx");
  const ws = wb.worksheets[0];
  const rows: unknown[][] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const arr: unknown[] = [];
    for (let c = 1; c <= 13; c++) { const v = ws.getRow(r).getCell(c).value; arr.push(v == null ? "" : (typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v)); }
    if (arr.some((x) => String(x).trim() !== "")) rows.push(arr);
  }

  const res = buildCnplus(rows, codeMap, ["제주마루 702호"]);
  console.log("입력 데이터행:", rows.length);
  console.log("stats:", JSON.stringify(res.stats));
  console.log("주소경고:", res.addressWarnings.length, "· 미매칭 SKU:", res.unmatched.length, res.unmatched.slice(0, 10));
  const q3 = res.guarantee.every((r) => r[16] === 3);
  console.log(`도착보장 Q열 전부 3? ${q3} (도착보장 ${res.guarantee.length}행)`);

  const show = (label: string, arr: unknown[][]) => {
    console.log(`\n[${label}] 상위 6행 (K단품코드 · N품목명 · P박스타입 · Q운임 · R운임비):`);
    for (const r of arr.slice(0, 6)) console.log(`  ${String(r[10]).padEnd(16)} | ${String(r[13]).replace(/\s+/g, " ").slice(0, 34).padEnd(34)} | P${r[15]} Q${r[16]} R${r[17]}`);
  };
  show("일반", res.normal);
  show("도착보장", res.guarantee);

  // 박스타입 분포
  const dist = new Map<unknown, number>();
  for (const r of [...res.normal, ...res.guarantee]) dist.set(r[15], (dist.get(r[15]) || 0) + 1);
  console.log("\n박스타입 분포:", [...dist].map(([k, v]) => `타입${k}:${v}`).join(" · "));

  // 택배량(주문 단위)
  console.log(`\n택배량 — 주문(택배) ${res.stats.parcels}건 (일반 ${res.stats.parcels - res.stats.parcelsGuar} · 도착보장 ${res.stats.parcelsGuar}):`);
  for (const p of res.parcelSummary) if (p.normal || p.guarantee) console.log(`  ${p.category.padEnd(6)} 일반 ${p.normal} · 도착보장 ${p.guarantee}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
