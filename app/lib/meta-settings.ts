import { getKv, setKv } from "./b2b-settings";

// 메타 광고 단계 판정 기준(시기별 커스텀). b2b_settings 에 JSON 저장.
export type MetaThresholds = {
  minSpend: number;        // 판정 최소 지출(이 미만이면 데이터 부족으로 판정 보류)
  // ── 소재테스트 예산 규칙(ABO) ──
  testDailyPerCreative: number; // 소재당 일일 예산(원). 세트 권장예산 = 이 값 × 소재수
  testDays: number;        // 소재테스트 기간(일)
  // ── 우수소재 기준(아래 셋 중 하나만 충족해도 통과 = OR) ──
  aboPassRoas: number;     // ① ROAS ≥
  aboMaxCpa: number;       // ② 목표 전환단가(CPA) ≤ (0=미사용)
  beatLiveCampaign: boolean; // ③ 현재 운영 중인 캠페인 ROAS 상회
  aboMinPurchases: number; // 판정 전 최소 전환수(데이터 충분 게이트)
  // ── 본 캠페인(CBO) 운영 ──
  scaleRoas: number;       // 증액 권장: ROAS ≥ (scaleDays 동안 매일)
  scaleDays: number;       // 증액 권장: 어제까지 이 일수만큼 연속 충족해야 함(하루 반짝 성과 배제)
  scalePct: number;        // 증액 비율(%) — 증액 버튼이 올리는 폭. 재증액 간격은 meta-scale.ts
  declineRoas: number;     // 효율 하락/위험: ROAS < (이 미만이면 위험소재 판정)
  // ── 소재 라이브러리 ──
  libraryRoas: number;     // 이 ROAS 이상 기록한 소재는 '라이브러리 저장 추천'
};

export const META_THRESHOLD_DEFAULTS: MetaThresholds = {
  minSpend: 50000,
  testDailyPerCreative: 20000,
  testDays: 7,
  aboPassRoas: 2.0,
  aboMaxCpa: 0,
  beatLiveCampaign: true,
  aboMinPurchases: 1,
  scaleRoas: 3.0,
  scaleDays: 3,
  scalePct: 20,
  declineRoas: 1.5,
  libraryRoas: 2.5,
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
