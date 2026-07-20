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
  boxes_normal_manual: BoxCounts; // 직접수정 보정(±)
  boxes_guar_manual: BoxCounts;
  manual_updated_at: string | null;
};

// DB 행 → 최종값 병합 행. 기존 소비처(통계·엑셀)는 boxes_*/base_fee_* 를 그대로 읽으면 최종값이 된다.
export function mergeDeliveryRow(row: Record<string, unknown>, history: RateVersion[]): MergedDeliveryRow {
  const log_date = String(row.log_date || "");
  const autoN = cleanBoxes(row.boxes_normal);
  const autoG = cleanBoxes(row.boxes_guar);
  const manN = cleanBoxes(row.boxes_normal_manual, true);
  const manG = cleanBoxes(row.boxes_guar_manual, true);
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
    manual_updated_at: (row.manual_updated_at as string) || null,
  };
}
