import { supabaseAdmin } from "./supabase";

// B2B 발주(생산대기·생산중)를 생산 계획(생산 일정·보드·제조사 요청서·재고/생산 조언)에
//  자동으로 끌어올지 여부. 재고 생산을 '도매 재고 생산 요청'으로 별도 운영하므로 꺼둠(2026-07 결정).
//  다시 켜려면 true. 발주의 생산상태 컬럼·값은 그대로 유지되므로 롤백은 이 플래그만 바꾸면 됨.
export const LINK_B2B_ORDERS_TO_PRODUCTION = false;

// ─────────────────────────────────────────────
// 생산 리드타임(일) — b2b_settings('production_lead_days') 에 숫자로 저장.
//  안전재고 = 하루 평균 출고 × (리드타임 + 발주 주기). "생산이 며칠 걸리는가"를 운영자가 조정.
//  기본 7일 = 수·목 요청 → 차주 월~금 입고(2026-09-17 대표 확정 운영 리듬).
// ─────────────────────────────────────────────

const KEY = "production_lead_days";
export const DEFAULT_LEAD_DAYS = 7;
const MIN_LEAD = 1;
const MAX_LEAD = 60;

function clamp(n: number): number {
  return Math.min(MAX_LEAD, Math.max(MIN_LEAD, Math.round(n)));
}

// ─────────────────────────────────────────────
// 발주 주기(일) — b2b_settings('production_cycle_days'). 요청서를 내는 간격(주 1회 = 7).
//  안전재고 지평 = 리드타임 + 발주 주기: 이번 물량이 도착한 뒤 '다음' 물량이 도착할 때까지 버틸 양까지
//  목표에 넣어야 도착 직전 바닥이 안 난다(리드타임만 잡으면 주 1회 발주에서 한 주가 비는 구조).
//  기본 0 = 종전 수식 그대로(1단계 검증은 '오는 중' 차감만 — 대표가 설정에서 켠다).
// ─────────────────────────────────────────────

const CYCLE_KEY = "production_cycle_days";
export const DEFAULT_CYCLE_DAYS = 0;
const MAX_CYCLE = 30;

export async function getCycleDays(): Promise<number> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", CYCLE_KEY).maybeSingle();
    const n = Number(data?.value);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_CYCLE_DAYS;
    return Math.min(MAX_CYCLE, Math.round(n));
  } catch {
    return DEFAULT_CYCLE_DAYS;
  }
}

export async function setCycleDays(days: number): Promise<number> {
  const sb = supabaseAdmin();
  const n = Number(days);
  const v = Number.isFinite(n) && n >= 0 ? Math.min(MAX_CYCLE, Math.round(n)) : DEFAULT_CYCLE_DAYS;
  await sb.from("b2b_settings").upsert(
    { key: CYCLE_KEY, value: v, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return v;
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
