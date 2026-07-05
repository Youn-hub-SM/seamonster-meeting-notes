// 택배(CJ CNplus) 발주처리 — 소매 주문 엑셀(A~M 13열) → CNplus 발주 18열(A~R).
//  구글시트(붙여넣기 N~R 수식)를 코드로 이관. A~M 은 그대로 통과, N~R 은 코드표/규칙으로 계산.
//  · N 품목명 = shipping_codes.courier_name[단품코드]
//  · O 박스수량 = 1
//  · P 박스타입 = 주문 총중량 U 로 구간 (≤2.7→1, ≤5.2→2, >5.2→3)
//  · Q 운임구분 = 1 (도착보장 3)
//  · R 기본운임 = U 구간 (≤2.7→2700, ≤5.2→3300, >5.2→3900)
//  주문 총중량 U = 같은 (주문번호 B, 주소 E) 라인들의 Σ( 코드 총중량 × 수량 I ).

export const CNPLUS_HEADERS = [
  "사용안함", "고객주문번호", "받는분성명", "우편번호", "받는분주소(전체, 분할)", "받는분전화번호",
  "사용안함", "사용안함", "내품수량", "배송메세지1", "품목코드", "사용안함", "사용안함",
  "품목명", "박스수량", "박스타입", "운임구분", "기본운임",
];

export const GUARANTEE_LABEL = "네이버 도착보장";

// 입력 A~M 열 인덱스(0-based)
const IDX = { dbNo: 0, orderNo: 1, name: 2, zip: 3, addr: 4, phone1: 5, phone2: 6, product: 7, qty: 8, msg: 9, sku: 10, date: 11, prop: 12 };

// 박스타입/기본운임 구간 (주문 총중량 kg). 값 바뀌면 여기만 수정.
export function boxType(w: number): number { return w <= 2.7 ? 1 : w <= 5.2 ? 2 : 3; }
export function baseFee(w: number): number { return w <= 2.7 ? 2700 : w <= 5.2 ? 3300 : 3900; }

export type CodeInfo = { courier_name: string; order_weight: number };
export type FulfillResult = {
  headers: string[];
  normal: unknown[][];        // A~R (18열) 일반
  guarantee: unknown[][];     // A~R 도착보장(Q=3)
  stats: { total: number; excludedNothing: number; normalCount: number; guaranteeCount: number };
  addressWarnings: { rowNo: number; addr: string; name: string }[];
  unmatched: string[];        // 코드표에 없는 단품코드
};

// rows: 헤더 제외한 데이터행(A~M). codeMap: 단품코드(대문자) → CodeInfo. keywords: 주소 경고어.
export function buildCnplus(rows: unknown[][], codeMap: Map<string, CodeInfo>, keywords: string[]): FulfillResult {
  // 1) 단품코드에 NOTHING 포함 행 제외(정기배송 등)
  const kept: unknown[][] = [];
  let excludedNothing = 0;
  for (const r of rows) {
    if (/NOTHING/i.test(String(r[IDX.sku] ?? ""))) { excludedNothing++; continue; }
    kept.push(r);
  }

  // 2) 주문키(주문번호+주소)별 총중량 U
  const gkey = (r: unknown[]) => `${String(r[IDX.orderNo] ?? "")}||${String(r[IDX.addr] ?? "")}`;
  const groupW = new Map<string, number>();
  const unmatched = new Set<string>();
  for (const r of kept) {
    const raw = String(r[IDX.sku] ?? "").trim();
    const info = codeMap.get(raw.toUpperCase());
    if (!info && raw) unmatched.add(raw);
    const t = (info?.order_weight ?? 0) * (Number(r[IDX.qty]) || 0);
    groupW.set(gkey(r), (groupW.get(gkey(r)) ?? 0) + t);
  }

  // 3) 18열 생성 + 도착보장 분리 + 주소 경고
  const normal: unknown[][] = [], guarantee: unknown[][] = [];
  const addressWarnings: FulfillResult["addressWarnings"] = [];
  kept.forEach((r, i) => {
    const info = codeMap.get(String(r[IDX.sku] ?? "").trim().toUpperCase());
    const U = groupW.get(gkey(r)) ?? 0;
    const isGuar = String(r[IDX.prop] ?? "").trim() === GUARANTEE_LABEL;
    const out: unknown[] = [];
    for (let c = 0; c < 13; c++) out.push(r[c] ?? "");     // A~M 원본 통과(타입 유지)
    out.push(info?.courier_name ?? "");                     // N 품목명
    out.push(1);                                            // O 박스수량
    out.push(boxType(U));                                   // P 박스타입
    out.push(isGuar ? 3 : 1);                               // Q 운임구분
    out.push(baseFee(U));                                   // R 기본운임
    (isGuar ? guarantee : normal).push(out);

    const addr = String(r[IDX.addr] ?? "");
    if (keywords.some((k) => k && addr.includes(k))) addressWarnings.push({ rowNo: i + 1, addr, name: String(r[IDX.name] ?? "") });
  });

  return {
    headers: CNPLUS_HEADERS, normal, guarantee,
    stats: { total: rows.length, excludedNothing, normalCount: normal.length, guaranteeCount: guarantee.length },
    addressWarnings, unmatched: [...unmatched],
  };
}
