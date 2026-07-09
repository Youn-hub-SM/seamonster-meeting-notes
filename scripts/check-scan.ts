// 송장 스캔 핵심 로직 검증 (DB 불필요) — npx tsx scripts/check-scan.ts
import { parseScanCells, parseCsv, findScanCols, buildScanTally, normInvoice, type ScanProduct, type BundleComp } from "../app/lib/fulfill-scan";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got  ${g}\n   want ${w}`); fail++; }
  else console.log(`✓ ${name}`);
};

// 1) 헤더 자동 인식
eq("헤더: 표준", findScanCols(["송장번호", "단품코드", "주문수량"]), { invoice: 0, code: 1, qty: 2 });
eq("헤더: 변형", findScanCols(["운송장번호", "옵션코드", "수량"]), { invoice: 0, code: 1, qty: 2 });
eq("헤더: 순서 뒤섞임", findScanCols(["상품명", "주문수량", "SKU", "송장번호"]), { invoice: 3, code: 2, qty: 1 });

// 2) parseScanCells — NOTHING 제외 + (송장,코드) 합산 + 고유송장 카운트
const cells = [
  ["송장번호", "단품코드", "주문수량"],
  ["1001", "AAA", 2],
  ["1001", "AAA", 1],      // 같은 (송장,코드) → 합산(3)
  ["1001", "BBB", 1],
  ["1002", "NOTHING_SUB", 5], // 제외
  ["1002", "AAA", 4],
  ["", "", ""],             // 빈행 무시
];
const p = parseScanCells(cells);
eq("parse: 라인수(병합후 3)", p.itemCount, 3);
eq("parse: 고유송장 2", p.invoiceCount, 2);
eq("parse: NOTHING 제외 1", p.excludedNothing, 1);
eq("parse: 1001·AAA 합산=3", p.rows.find((r) => r.invoice_no === "1001" && r.sku_code === "AAA")?.qty, 3);

// 3) buildScanTally — 묶음(세트) 전개
const bySku = new Map<string, ScanProduct>([
  ["AAA", { id: "a", sku: "AAA", name: "상품A" }],
  ["BBB", { id: "b", sku: "BBB", name: "상품B" }],
  ["SET1", { id: "s", sku: "SET1", name: "세트1" }],
]);
const byId = new Map<string, ScanProduct>([...bySku.values()].map((p2) => [p2.id, p2]));
const bundles = new Map<string, BundleComp[]>([["s", [{ component_id: "a", qty: 2 }, { component_id: "b", qty: 1 }]]]);
const items = [
  { invoice_no: "1001", sku_code: "SET1", qty: 1 }, // → A×2 + B×1
  { invoice_no: "1001", sku_code: "AAA", qty: 3 },  // → A×3
  { invoice_no: "1002", sku_code: "BBB", qty: 1 },  // → B×1
  { invoice_no: "1003", sku_code: "ZZZ", qty: 9 },  // 미등록
];
// 1001 만 스캔: A=2+3=5, B=1
const t1 = buildScanTally(items, new Set(["1001"]), bySku, byId, bundles);
eq("tally(1001): 상품A=5", t1.find((r) => r.sku === "AAA")?.qty, 5);
eq("tally(1001): 상품B=1", t1.find((r) => r.sku === "BBB")?.qty, 1);
eq("tally(1001): 미스캔 제외", t1.length, 2);
// 1001+1002 스캔: B=1+1=2
const t2 = buildScanTally(items, new Set(["1001", "1002"]), bySku, byId, bundles);
eq("tally(1001+1002): 상품B=2", t2.find((r) => r.sku === "BBB")?.qty, 2);
// 미등록 코드 스캔 → unknown 행
const t3 = buildScanTally(items, new Set(["1003"]), bySku, byId, bundles);
eq("tally(1003): unknown 표시", t3.map((r) => [r.unknown, r.qty]), [[true, 9]]);

// 4b) CJ 파일접수 형태 — 단품코드는 비고 상품코드에 SKU, 내품수량 우선(빈 열 회피 + 별칭 우선순위)
const cj = [
  ["운송장번호", "박스타입", "수량", "내품수량", "고객주문번호", "상품코드", "상품명", "단품코드"],
  ["6989-5042-8406", "중", 1, 2, "S60606", "BULK-CD-100", "참돔순살", ""],
  ["6989-5042-8410", "중", 1, 3, "S60597", "BULK-GA-100", "광어순살", ""],
];
const pcj = parseScanCells(cj);
eq("CJ: invoice=운송장번호(0)", pcj.cols.invoice, 0);
eq("CJ: code=상품코드(5, 빈 단품코드 회피)", pcj.cols.code, 5);
eq("CJ: qty=내품수량(3, 박스수량 아님)", pcj.cols.qty, 3);
eq("CJ: 내품수량 반영", pcj.rows.map((r) => r.qty), [2, 3]);

// 4c) 송장번호 정규화 — 하이픈/공백 무관(바코드=하이픈 없음)
eq("normInvoice: 하이픈 제거", normInvoice("6989-5042-8406"), "698950428406");
eq("normInvoice: 공백·소문자", normInvoice(" ab 12-34 "), "AB1234");
const nz = parseScanCells([["송장번호", "단품코드", "수량"], ["6989-5042-8406", "AAA", 1]]);
eq("parse: 송장 정규화 저장", nz.rows[0]?.invoice_no, "698950428406");

// 4) CSV 파싱(따옴표·쉼표)
const csv = parseCsv('송장번호,단품코드,주문수량\n"1,001",AAA,2\n1002,"BB,B",3\n');
eq("csv: 따옴표 안 쉼표 보존", csv[1], ["1,001", "AAA", "2"]);
eq("csv: 필드 보존", csv[2], ["1002", "BB,B", "3"]);

console.log(fail === 0 ? "\n✅ 전체 통과" : `\n❌ 실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
