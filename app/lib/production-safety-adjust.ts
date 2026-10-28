import { mutateKv, readKvSoft } from "./production-kv";

// ─────────────────────────────────────────────
// 안전재고 수동 보정 — b2b_settings('production_safety_adjust') 에 SKU별로 저장.
//  자동 목표(출고×목표 일수 — 생산 일정 기반) 위에 사람이 직접 더/덜 잡는 값.
//  만료일(until)을 지정하면 그날이 지나면 자동으로 무시(0 처리)된다.
//  저장은 production-kv mutateKv — 읽기 실패면 저장을 거절한다(빈 값 + 이번 1건으로 다른 SKU 보정을 지우지 않게, S4).
// ─────────────────────────────────────────────

const KEY = "production_safety_adjust";

export interface SafetyAdjust {
  delta: number;          // 추가 확보: 안전재고에 더할 양 (음수 가능)
  excludeOut?: number;    // 행사 출고 빼기: 집계창에서 평상시 속도에서 제외할 행사 출고량(≥0)
  memo?: string;          // 사유 (예: "여름 프로모션")
  until?: string | null;  // YYYY-MM-DD — 이 날짜가 지나면 무시
}

type AdjMap = Record<string, SafetyAdjust>;
const asMap = (v: unknown): AdjMap => (v && typeof v === "object" && !Array.isArray(v) ? (v as AdjMap) : {});

// 계산 경로용 — 실패해도 빈 값으로 계속 돌되 ok=false(호출부가 경고·초안 중단)
export async function getSafetyAdjustsWithOk(): Promise<{ adjusts: AdjMap; ok: boolean }> {
  const r = await readKvSoft<AdjMap>(KEY);
  return { adjusts: asMap(r.value), ok: r.ok };
}

// 만료가 지나지 않은 유효 보정값만 반환(만료 지났으면 0).
export function effectiveDelta(adj: SafetyAdjust | undefined, today: string): number {
  if (!adj) return 0;
  if (adj.until && adj.until < today) return 0;
  return Math.round(Number(adj.delta) || 0);
}

// 만료 안 지난 유효 '행사 출고 빼기' 양(≥0). 평상시 속도에서 차감할 행사 출고.
export function effectiveExclude(adj: SafetyAdjust | undefined, today: string): number {
  if (!adj) return 0;
  if (adj.until && adj.until < today) return 0;
  return Math.max(0, Math.round(Number(adj.excludeOut) || 0));
}
