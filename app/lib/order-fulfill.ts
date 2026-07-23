// 택배(CJ CNplus) 발주처리 — 소매 주문 엑셀(A~M 13열) → CNplus 발주 18열(A~R).
//  구글시트(붙여넣기 N~R 수식)를 코드로 이관. A~M 은 그대로 통과, N~R 은 코드표/규칙으로 계산.
//  · N 품목명 = shipping_codes.courier_name[단품코드]
//  · O 박스수량 = 1
//  · P 박스타입 = 주문 총중량 U 로 구간 (≤2.7→1, ≤5.2→2, >5.2→3)
//  · Q 운임구분 = 1 (도착보장 3)
//  · R 기본운임 = U 구간 (≤2.7→2700, ≤5.2→3300, >5.2→3900)
//  주문 총중량 U = 같은 (주문번호 B, 주소 E) 라인들의 Σ( 코드 총중량 × 수량 I ).

import { type FulfillRates, type BoxTier, DEFAULT_RATES, boxTypeOf, baseFeeOf } from "./fulfill-rates";

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
export const GUAR_SURCHARGE = 143; // 도착보장 건당 운임(원). 이제 도착보장 '기본운임'에 143×건이 포함됨(추가운임은 제주 등 수동).

// 택배량 집계용 박스종류(주문 총중량 구간). 배송일지 '해당 주문건 박스 종류'와 동일.
export const BOX_CATEGORIES = ["굴", "생굴", "김치8", "김치10", "12kg", "15kg", "20kg", "25kg"] as const;
export function boxCategory(w: number): string {
  return w < 1.7 ? "굴" : w <= 2.7 ? "생굴" : w <= 4 ? "김치8" : w <= 5.2 ? "김치10"
    : w <= 9 ? "12kg" : w <= 11 ? "15kg" : w < 16 ? "20kg" : "25kg";
}

// 박스종류별 대표 중량(요율 구간에 대입해 기본운임 산출용). 각 종류 무게범위 안의 값.
export const BOX_CATEGORY_WEIGHT: Record<(typeof BOX_CATEGORIES)[number], number> = {
  "굴": 1.5, "생굴": 2.5, "김치8": 3.5, "김치10": 5.0, "12kg": 7, "15kg": 10, "20kg": 13, "25kg": 20,
};

// 박스종류별 개수 → 기본운임 합. 각 종류 대표중량을 요율 구간(tiers)에 대입해 합산.
//  배송일지 '택배량 직접수정'에서 개수를 고치면 기본운임이 이 함수로 다시 계산된다.
//  (박스종류 경계가 요율 구간의 하위분할이라, 발주처리 시점 ΣbaseFeeOf(주문중량) 과 정확히 일치)
export function baseFeeFromBoxes(boxes: Record<string, number> | null | undefined, tiers: BoxTier[]): number {
  let sum = 0;
  for (const cat of BOX_CATEGORIES) {
    const cnt = Math.max(0, Math.round(Number(boxes?.[cat]) || 0));
    if (cnt) sum += cnt * baseFeeOf(BOX_CATEGORY_WEIGHT[cat], tiers);
  }
  return sum;
}

// L열(날짜) 셀 → YYYY-MM-DD. 엑셀 날짜셀(Date)·직렬값(number)·문자열 모두 방어 파싱, 실패 시 null.
//  출고를 '주문일' 축으로 기록해 매출(주문일자)과 같은 축에서 완전 대조하기 위함 — 실패 행은 처리일로 폴백.
export function dateCellToIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    // exceljs 날짜셀은 UTC 기준 Date — UTC 부품으로 조립해야 하루 밀림이 없다
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 20000 && v < 60000) {
    return new Date(Math.round((v - 25569) * 86400e3)).toISOString().slice(0, 10); // 엑셀 직렬값(25569=1970-01-01)
  }
  const s = String(v).trim();
  let m = s.match(/(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export type CodeInfo = { courier_name: string; order_weight: number };
export type ParcelCount = { category: string; normal: number; guarantee: number };
export type FulfillResult = {
  headers: string[];
  normal: unknown[][];        // A~R (18열) 일반
  guarantee: unknown[][];     // A~R 도착보장(Q=3)
  stats: { total: number; excludedNothing: number; normalCount: number; guaranteeCount: number; parcels: number; parcelsGuar: number; mergedParcels: number };
  fees: { baseNormal: number; baseGuar: number; guarExtra: number }; // baseGuar=도착보장 기본운임(중량구간 + 143×건). guarExtra=0(추가운임은 배송일지에서 제주 등 수동). 배송일지 기록용
  parcelSummary: ParcelCount[]; // 박스종류별 택배량(주문 단위, 일반/도착보장)
  addressWarnings: { rowNo: number; addr: string; name: string }[];
  unmatched: string[];        // 상품마스터(택배코드)에 없는 단품코드
  outbound: { sku: string; name: string; qty: number; orderDate: string | null }[]; // (주문일 L열 × SKU)별 출고수량(정기배송 제외) — 재고 출고를 주문일 축으로 기록
};

// rows: 헤더 제외한 데이터행(A~M). codeMap: 단품코드(대문자) → CodeInfo. keywords: 주소 경고어. rates: 요율(기본운임 구간·도착보장 추가).
export function buildCnplus(rows: unknown[][], codeMap: Map<string, CodeInfo>, keywords: string[], rates: FulfillRates = DEFAULT_RATES): FulfillResult {
  const boxTypeR = (w: number) => boxTypeOf(w, rates.boxTiers);
  const baseFeeR = (w: number) => baseFeeOf(w, rates.boxTiers);
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
  const groupGuar = new Map<string, boolean>();  // 주문에 도착보장 라인이 하나라도 있으면 true
  const groupDb = new Map<string, Set<string>>();   // 주문키 → DB번호(A열, 비어있지 않은 것만)
  const groupAddr = new Map<string, string>();      // 주문키 → 주소(공백 제거) — 합배송 2중 체크용
  const groupName = new Map<string, string>();      // 주문키 → 받는분성명
  const unmatched = new Set<string>();
  for (const r of kept) {
    const raw = String(r[IDX.sku] ?? "").trim();
    const info = codeMap.get(raw.toUpperCase());
    if (!info && raw) unmatched.add(raw);
    const t = (info?.order_weight ?? 0) * (Number(r[IDX.qty]) || 0);
    const k = gkey(r);
    groupW.set(k, (groupW.get(k) ?? 0) + t);
    if (String(r[IDX.prop] ?? "").trim() === GUARANTEE_LABEL) groupGuar.set(k, true);
    const db = String(r[IDX.dbNo] ?? "").trim();
    if (db) { const s = groupDb.get(k) ?? new Set<string>(); s.add(db); groupDb.set(k, s); }
    if (!groupAddr.has(k)) groupAddr.set(k, String(r[IDX.addr] ?? "").replace(/\s+/g, ""));
    if (!groupName.has(k)) groupName.set(k, String(r[IDX.name] ?? "").trim());
  }

  // 2b) 합배송 병합 — 고객주문번호가 달라도 DB번호(A열)가 같으면 실제로는 한 박스(합배송)로 나간다.
  //  2중 체크: 주소(공백 제거) 또는 받는분성명까지 같을 때만 병합 — 무관한 주문에 같은 DB번호가 잘못
  //  들어있는 경우(데이터 오류)의 오병합 방어. 병합은 택배량·운임·배송일지 '집계'에만 적용하고,
  //  CNplus 파일의 각 행(P 박스타입·R 기본운임)은 기존 그대로 둔다 — 물류사로 나가는 파일은 불변.
  const parent = new Map<string, string>();
  for (const k of groupW.keys()) parent.set(k, k);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const byDb = new Map<string, string[]>();
  for (const [k, dbs] of groupDb) for (const db of dbs) { const a = byDb.get(db) ?? []; a.push(k); byDb.set(db, a); }
  for (const keys of byDb.values()) {
    if (keys.length < 2) continue;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[0], b = keys[i];
      const sameAddr = !!groupAddr.get(a) && groupAddr.get(a) === groupAddr.get(b);
      const sameName = !!groupName.get(a) && groupName.get(a) === groupName.get(b);
      if (sameAddr || sameName) parent.set(find(b), find(a));
    }
  }
  const superW = new Map<string, number>();       // 병합 후 박스별 총중량
  const superGuar = new Map<string, boolean>();
  for (const [k, U] of groupW) {
    const r0 = find(k);
    superW.set(r0, (superW.get(r0) ?? 0) + U);
    if (groupGuar.get(k) === true) superGuar.set(r0, true);
  }
  const mergedParcels = groupW.size - superW.size; // 병합으로 줄어든 박스 수

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
    out.push(boxTypeR(U));                                  // P 박스타입
    out.push(isGuar ? 3 : 1);                               // Q 운임구분
    out.push(baseFeeR(U));                                  // R 기본운임
    (isGuar ? guarantee : normal).push(out);

    const addr = String(r[IDX.addr] ?? "");
    if (keywords.some((k) => k && addr.includes(k))) addressWarnings.push({ rowNo: i + 1, addr, name: String(r[IDX.name] ?? "") });
  });

  // 택배량: 합배송 병합 후 박스 단위로 박스종류별 일반/도착보장 개수 집계
  //  (병합된 박스는 합산 중량으로 종류·기본운임 산정 — 실제 발송 박스와 일치)
  const counts = new Map<string, { normal: number; guarantee: number }>();
  for (const cat of BOX_CATEGORIES) counts.set(cat, { normal: 0, guarantee: 0 });
  let parcels = 0, parcelsGuar = 0, baseNormal = 0, baseGuar = 0;
  for (const [k, U] of superW) {
    parcels++;
    const guar = superGuar.get(k) === true;
    const c = counts.get(boxCategory(U))!;
    if (guar) { parcelsGuar++; c.guarantee++; baseGuar += baseFeeR(U); }
    else { c.normal++; baseNormal += baseFeeR(U); }
  }
  const parcelSummary = BOX_CATEGORIES.map((cat) => ({ category: cat, ...counts.get(cat)! }));

  // (주문일 L열 × SKU)별 출고수량(정기배송 제외) — 매출(주문일자)과 같은 축으로 재고 출고 기록.
  //  한 발주 배치에 이틀 치 주문이 섞이므로(수집 마감 시각 기준) 주문일별로 분해해야 완전 대조가 성립.
  const outMap = new Map<string, { sku: string; name: string; qty: number; orderDate: string | null }>();
  for (const r of kept) {
    const sku = String(r[IDX.sku] ?? "").trim();
    const q = Number(r[IDX.qty]) || 0;
    if (!sku || q <= 0) continue;
    const orderDate = dateCellToIso(r[IDX.date]);
    const key = `${orderDate || ""}||${sku.toUpperCase()}`;
    const cur = outMap.get(key) ?? { sku, name: String(r[IDX.product] ?? "").trim(), qty: 0, orderDate };
    cur.qty += q;
    outMap.set(key, cur);
  }
  const outbound = [...outMap.values()].sort((a, b) => b.qty - a.qty);

  return {
    headers: CNPLUS_HEADERS, normal, guarantee,
    stats: { total: rows.length, excludedNothing, normalCount: normal.length, guaranteeCount: guarantee.length, parcels, parcelsGuar, mergedParcels },
    fees: { baseNormal, baseGuar: baseGuar + rates.guarSurcharge * parcelsGuar, guarExtra: 0 }, // 도착보장 기본운임 = 중량구간 + 143×도착보장건. 추가운임은 배송일지에서 제주 등 수동
    parcelSummary,
    addressWarnings, unmatched: [...unmatched], outbound,
  };
}
