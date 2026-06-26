import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 안전재고 수동 보정 — b2b_settings('production_safety_adjust') 에 SKU별로 저장.
//  자동 안전재고(출고×리드타임) + 프로모션 자동가산 위에 사람이 직접 더/덜 잡는 값.
//  만료일(until)을 지정하면 그날이 지나면 자동으로 무시(0 처리)된다.
// ─────────────────────────────────────────────

const KEY = "production_safety_adjust";

export interface SafetyAdjust {
  delta: number;          // 추가 확보: 안전재고에 더할 양 (음수 가능)
  excludeOut?: number;    // 행사 출고 빼기: 집계창에서 평상시 속도에서 제외할 행사 출고량(≥0)
  memo?: string;          // 사유 (예: "여름 프로모션")
  until?: string | null;  // YYYY-MM-DD — 이 날짜가 지나면 무시
}

export async function getSafetyAdjusts(): Promise<Record<string, SafetyAdjust>> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    const v = data?.value;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, SafetyAdjust>) : {};
  } catch {
    return {};
  }
}

export async function setSafetyAdjust(sku: string, adj: SafetyAdjust): Promise<Record<string, SafetyAdjust>> {
  const sb = supabaseAdmin();
  const cur = await getSafetyAdjusts();
  const key = (sku || "").trim().toUpperCase();
  if (!key) return cur;
  const delta = Math.round(Number(adj.delta) || 0);
  const excludeOut = Math.max(0, Math.round(Number(adj.excludeOut) || 0));
  const memo = (adj.memo || "").trim();
  const until = (adj.until || "").trim() || null;
  if (delta === 0 && excludeOut === 0 && !memo) {
    delete cur[key]; // 보정값·행사출고·메모 모두 없으면 제거(기본 복귀)
  } else {
    cur[key] = { delta, ...(excludeOut ? { excludeOut } : {}), ...(memo ? { memo } : {}), ...(until ? { until } : {}) };
  }
  await sb.from("b2b_settings").upsert(
    { key: KEY, value: cur, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return cur;
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
