import { getKv, setKv } from "./b2b-settings";

// 메타 광고 단계 판정 기준(시기별 커스텀). b2b_settings 에 JSON 저장.
export type MetaThresholds = {
  minSpend: number;      // 판정 최소 지출(이 미만이면 데이터 부족으로 판정 보류)
  aboPassRoas: number;   // ABO 통과: ROAS ≥
  aboMaxCpa: number;     // ABO 통과 보조: CPA ≤ (0=미사용)
  aboMinPurchases: number; // ABO 통과 보조: 구매수 ≥
  scaleRoas: number;     // 증액 권장: ROAS ≥
  scaleDays: number;     // 증액 권장: N일 이상 유지(현재는 선택 기간 기준)
  scalePct: number;      // 증액 권장 비율(%)
  declineRoas: number;   // 효율 하락: ROAS <
};

export const META_THRESHOLD_DEFAULTS: MetaThresholds = {
  minSpend: 50000,
  aboPassRoas: 2.0,
  aboMaxCpa: 0,
  aboMinPurchases: 1,
  scaleRoas: 3.0,
  scaleDays: 3,
  scalePct: 20,
  declineRoas: 1.5,
};

const KEY = "meta_thresholds";

export async function getMetaThresholds(): Promise<MetaThresholds> {
  const raw = await getKv(KEY);
  if (!raw) return { ...META_THRESHOLD_DEFAULTS };
  try {
    const v = JSON.parse(raw) as Partial<MetaThresholds>;
    return { ...META_THRESHOLD_DEFAULTS, ...v };
  } catch { return { ...META_THRESHOLD_DEFAULTS }; }
}

export async function saveMetaThresholds(t: Partial<MetaThresholds>): Promise<MetaThresholds> {
  const merged = { ...(await getMetaThresholds()), ...t };
  await setKv(KEY, JSON.stringify(merged));
  return merged;
}
