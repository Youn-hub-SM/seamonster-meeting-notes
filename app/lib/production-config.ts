import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 생산 리드타임(일) — b2b_settings('production_lead_days') 에 숫자로 저장.
//  안전재고 = 하루 평균 출고 × 리드타임. "생산이 며칠 걸리는가"를 운영자가 조정.
// ─────────────────────────────────────────────

const KEY = "production_lead_days";
export const DEFAULT_LEAD_DAYS = 10;
const MIN_LEAD = 1;
const MAX_LEAD = 60;

function clamp(n: number): number {
  return Math.min(MAX_LEAD, Math.max(MIN_LEAD, Math.round(n)));
}

export async function getLeadDays(): Promise<number> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    const n = Number(data?.value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEAD_DAYS;
    return clamp(n);
  } catch {
    return DEFAULT_LEAD_DAYS;
  }
}

export async function setLeadDays(days: number): Promise<number> {
  const sb = supabaseAdmin();
  const v = clamp(Number(days) || DEFAULT_LEAD_DAYS);
  await sb.from("b2b_settings").upsert(
    { key: KEY, value: v, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return v;
}
