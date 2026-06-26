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

// ─────────────────────────────────────────────
// 도매/소매 채널 de-mix 설정 — 같은 SKU로 도매·소매가 섞여 나가는 품목에 한해
//  소매 판매속도에서 '과거 B2B 발송분'을 빼서 평상시 소매 속도만 잡는다.
//  기본 OFF + SKU 화이트리스트 opt-in + under-subtract 계수(가정이 틀려도 쇼트 방지).
// ─────────────────────────────────────────────
const DEMIX_ENABLED_KEY = "production_demix_enabled";
const DEMIX_SKUS_KEY = "production_demix_skus";
const DEMIX_FACTOR_KEY = "production_demix_factor";
export const DEFAULT_DEMIX_FACTOR = 0.6;

async function readSetting(key: string): Promise<unknown> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", key).maybeSingle();
    return data?.value;
  } catch {
    return undefined;
  }
}
async function writeSetting(key: string, value: unknown): Promise<void> {
  const sb = supabaseAdmin();
  await sb.from("b2b_settings").upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

export async function getDemixEnabled(): Promise<boolean> {
  return (await readSetting(DEMIX_ENABLED_KEY)) === true;
}
export async function setDemixEnabled(on: boolean): Promise<boolean> {
  await writeSetting(DEMIX_ENABLED_KEY, !!on);
  return !!on;
}
export async function getDemixSkus(): Promise<string[]> {
  const v = await readSetting(DEMIX_SKUS_KEY);
  return Array.isArray(v) ? (v as unknown[]).map((s) => String(s).toUpperCase()) : [];
}
export async function setDemixSkus(skus: string[]): Promise<string[]> {
  const clean = [...new Set((skus || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  await writeSetting(DEMIX_SKUS_KEY, clean);
  return clean;
}
export async function getDemixFactor(): Promise<number> {
  const n = Number(await readSetting(DEMIX_FACTOR_KEY));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEMIX_FACTOR;
  return Math.min(1, n);
}
export async function setDemixFactor(f: number): Promise<number> {
  const v = Math.min(1, Math.max(0, Number(f) || 0));
  await writeSetting(DEMIX_FACTOR_KEY, v);
  return v;
}
