import type { supabaseAdmin } from "./supabase";

// 창고 픽업 구역(선반) — 송장 스캔 피킹 리스트를 '걷는 순서'로 정렬하기 위한 구역 목록.
//  · 구역 배열의 순서 = 창고를 걷는 경로. b2b_settings 'pick_zones' (jsonb {zones:[...]}) 에 저장 — 별도 테이블 없음.
//  · 품목 → 구역 배정은 products.pick_zone (migration 117). 컬럼 미적용이어도 스캔이 죽지 않게 폴백은 fulfill-scan.ts 에.

export const PICK_ZONES_KEY = "pick_zones";
export const MAX_ZONES = 50;

// 구역 목록 정리: 공백 제거·빈 값 제외·중복 제거·길이 상한. 순서는 유지.
export function normalizeZones(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const s = String(v ?? "").trim().slice(0, 40);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_ZONES) break;
  }
  return out;
}

export async function getPickZones(sb: ReturnType<typeof supabaseAdmin>): Promise<string[]> {
  try {
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", PICK_ZONES_KEY).maybeSingle();
    if (error || !data) return [];
    const v = data.value as { zones?: unknown } | null;
    return normalizeZones(v?.zones);
  } catch {
    return [];
  }
}

export async function savePickZones(sb: ReturnType<typeof supabaseAdmin>, zones: string[]): Promise<string[]> {
  const clean = normalizeZones(zones);
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: PICK_ZONES_KEY, value: { zones: clean }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
  return clean;
}
