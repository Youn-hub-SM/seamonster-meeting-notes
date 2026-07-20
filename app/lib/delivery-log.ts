import { BOX_CATEGORIES, BOX_CATEGORY_WEIGHT } from "./order-fulfill";
import { baseFeeOf, ratesFor, type RateVersion } from "./fulfill-rates";

// 배송일지 자동입력/직접수정 병합 — 화면·통계·엑셀이 같은 '최종값'을 쓰도록 한 곳에서 파생.
//  자동입력(boxes_*, base_fee_* = 발주처리 기록) + 직접수정 보정(boxes_*_manual, ±) →
//  최종 택배량 = max(0, 자동+보정) · 최종 기본운임 = 자동운임 + Σ(보정 × 그날 박스종류 대표단가).

export type BoxCounts = Record<string, number>;

// 알려진 박스종류만 정수로 정제. signed=true 면 음수(빼기 보정) 허용.
export function cleanBoxes(o: unknown, signed = false): BoxCounts {
  const out: BoxCounts = {};
  if (o && typeof o === "object") for (const c of BOX_CATEGORIES) {
    const raw = Math.round(Number((o as Record<string, unknown>)[c]) || 0);
    const n = signed ? raw : Math.max(0, raw);
    if (n !== 0) out[c] = n;
  }
  return out;
}

export const sumCounts = (o: BoxCounts): number => Object.values(o).reduce((a, b) => a + b, 0);

// 최종 수량 = 자동 + 보정 (박스종류별 0 미만 방지)
export function mergeCounts(auto: BoxCounts, manual: BoxCounts): BoxCounts {
  const out: BoxCounts = {};
  for (const c of BOX_CATEGORIES) {
    const v = Math.max(0, (auto[c] || 0) + (manual[c] || 0));
    if (v > 0) out[c] = v;
  }
  return out;
}

// 보정분 운임(부호 유지) = Σ 보정개수 × 그 박스종류 대표중량의 기본운임
export function manualFeeDelta(manual: BoxCounts, tiers: RateVersion["boxTiers"]): number {
  let sum = 0;
  for (const c of BOX_CATEGORIES) {
    const cnt = manual[c] || 0;
    if (cnt) sum += cnt * baseFeeOf(BOX_CATEGORY_WEIGHT[c as keyof typeof BOX_CATEGORY_WEIGHT], tiers);
  }
  return sum;
}

// 직접수정 내역 1건 — 왜 고쳤는지(note)까지 기록
export type ManualEntry = {
  id: string;
  side: "n" | "g";        // 일반/도착보장
  category: string;        // 박스종류
  qty: number;             // ±수량
  note: string;            // 내용(사유)
  at: string;              // 기록 시각(ISO)
  by?: string | null;      // 작업자
};

export function cleanEntries(o: unknown): ManualEntry[] {
  if (!Array.isArray(o)) return [];
  const out: ManualEntry[] = [];
  for (const e of o as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const side = e.side === "g" ? "g" : "n";
    const category = String(e.category || "");
    const qty = Math.round(Number(e.qty) || 0);
    if (!(BOX_CATEGORIES as readonly string[]).includes(category) || qty === 0) continue;
    out.push({ id: String(e.id || ""), side, category, qty, note: String(e.note || ""), at: String(e.at || ""), by: (e.by as string) ?? null });
  }
  return out;
}

// 내역 → 박스종류별 보정 합(±)
export function entriesToCounts(entries: ManualEntry[], side: "n" | "g"): BoxCounts {
  const out: BoxCounts = {};
  for (const e of entries) if (e.side === side) out[e.category] = (out[e.category] || 0) + e.qty;
  for (const c of Object.keys(out)) if (out[c] === 0) delete out[c];
  return out;
}

export function addCounts(a: BoxCounts, b: BoxCounts): BoxCounts {
  const out: BoxCounts = { ...a };
  for (const [c, v] of Object.entries(b)) {
    const n = (out[c] || 0) + v;
    if (n === 0) delete out[c]; else out[c] = n;
  }
  return out;
}

// 자동입력(발주처리 '배송일지에 기록') 1건 — 배치 단위 이력. 합계 = 이력 합, 건별 되돌리기 가능.
export type RecordEntry = {
  id: string;
  at: string;                       // 기록 시각(ISO)
  by?: string | null;               // 작업자
  mode: "add" | "replace" | "baseline"; // baseline = 이력 도입 전 기존 합계(1건으로 캡처)
  boxes_normal: BoxCounts;
  boxes_guar: BoxCounts;
  base_fee_normal: number;
  base_fee_guar: number;
  sig: string;                      // 내용 서명(중복 판정: 같은 날짜 + 같은 sig = 중복)
};

export function cleanRecordEntries(o: unknown): RecordEntry[] {
  if (!Array.isArray(o)) return [];
  const out: RecordEntry[] = [];
  for (const e of o as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    out.push({
      id: String(e.id || ""),
      at: String(e.at || ""),
      by: (e.by as string) ?? null,
      mode: e.mode === "replace" ? "replace" : e.mode === "baseline" ? "baseline" : "add",
      boxes_normal: cleanBoxes(e.boxes_normal),
      boxes_guar: cleanBoxes(e.boxes_guar),
      base_fee_normal: Math.round(Number(e.base_fee_normal) || 0),
      base_fee_guar: Math.round(Number(e.base_fee_guar) || 0),
      sig: String(e.sig || ""),
    });
  }
  return out;
}

// 이력 합 → 자동입력 컬럼 값(박스 합·운임 합)
export function recordTotals(entries: RecordEntry[]): { boxes_normal: BoxCounts; boxes_guar: BoxCounts; base_fee_normal: number; base_fee_guar: number } {
  let bn: BoxCounts = {}, bg: BoxCounts = {}, fn = 0, fg = 0;
  for (const e of entries) {
    bn = addCounts(bn, e.boxes_normal);
    bg = addCounts(bg, e.boxes_guar);
    fn += e.base_fee_normal;
    fg += e.base_fee_guar;
  }
  // 자동 합계는 음수가 없어야 정상 — 방어적으로 0 미만 제거
  for (const c of Object.keys(bn)) if (bn[c] < 0) delete bn[c];
  for (const c of Object.keys(bg)) if (bg[c] < 0) delete bg[c];
  return { boxes_normal: bn, boxes_guar: bg, base_fee_normal: Math.max(0, fn), base_fee_guar: Math.max(0, fg) };
}

export type MergedDeliveryRow = Record<string, unknown> & {
  log_date: string;
  boxes_normal: BoxCounts;        // 최종(자동+보정)
  boxes_guar: BoxCounts;
  base_fee_normal: number;        // 최종 기본운임
  base_fee_guar: number;
  boxes_normal_auto: BoxCounts;   // 자동입력 원본(발주처리 기록)
  boxes_guar_auto: BoxCounts;
  base_fee_normal_auto: number;
  base_fee_guar_auto: number;
  boxes_normal_manual: BoxCounts; // 직접수정 보정 합(± = 내역 합 + 075 구컬럼 잔여)
  boxes_guar_manual: BoxCounts;
  manual_entries: ManualEntry[];  // 건별 내역(사유 포함)
  record_entries: RecordEntry[];  // 자동입력 배치 이력(되돌리기용)
  manual_updated_at: string | null;
};

// DB 행 → 최종값 병합 행. 기존 소비처(통계·엑셀)는 boxes_*/base_fee_* 를 그대로 읽으면 최종값이 된다.
export function mergeDeliveryRow(row: Record<string, unknown>, history: RateVersion[]): MergedDeliveryRow {
  const log_date = String(row.log_date || "");
  const autoN = cleanBoxes(row.boxes_normal);
  const autoG = cleanBoxes(row.boxes_guar);
  const entries = cleanEntries(row.manual_entries);
  // 보정 합 = 내역 합 + 구컬럼(075, 내역 도입 전 저장분) 잔여값
  const manN = addCounts(cleanBoxes(row.boxes_normal_manual, true), entriesToCounts(entries, "n"));
  const manG = addCounts(cleanBoxes(row.boxes_guar_manual, true), entriesToCounts(entries, "g"));
  const rt = ratesFor(history, log_date);
  const feeN = Math.max(0, Math.round(Number(row.base_fee_normal) || 0) + manualFeeDelta(manN, rt.boxTiers));
  // 도착보장 보정은 박스당 도착보장 가산(guarSurcharge)도 함께 반영
  const feeG = Math.max(0, Math.round(Number(row.base_fee_guar) || 0) + manualFeeDelta(manG, rt.boxTiers) + rt.guarSurcharge * sumCounts(manG));
  return {
    ...row,
    log_date,
    boxes_normal: mergeCounts(autoN, manN),
    boxes_guar: mergeCounts(autoG, manG),
    base_fee_normal: feeN,
    base_fee_guar: feeG,
    boxes_normal_auto: autoN,
    boxes_guar_auto: autoG,
    base_fee_normal_auto: Math.round(Number(row.base_fee_normal) || 0),
    base_fee_guar_auto: Math.round(Number(row.base_fee_guar) || 0),
    boxes_normal_manual: manN,
    boxes_guar_manual: manG,
    manual_entries: entries,
    record_entries: cleanRecordEntries(row.record_entries),
    manual_updated_at: (row.manual_updated_at as string) || null,
  };
}
