import { supabaseAdmin } from "./supabase";

// B2B 발주(생산대기·생산중)를 생산 계획(생산 일정·보드·제조사 요청서·재고/생산 조언)에
//  자동으로 끌어올지 여부. 재고 생산을 '도매 재고 생산 요청'으로 별도 운영하므로 꺼둠(2026-07 결정).
//  다시 켜려면 true. 발주의 생산상태 컬럼·값은 그대로 유지되므로 롤백은 이 플래그만 바꾸면 됨.
export const LINK_B2B_ORDERS_TO_PRODUCTION = false;

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

// ─────────────────────────────────────────────
// 열린 요청서 부하(production-openload)의 시한 설정 — b2b_settings 에 숫자로 저장.
//  docs/demand-streams-plan.md 5·7·8절. 없으면 기본값으로 동작하므로 마이그레이션 불필요.
//   · 예약 유예일   = 도매 납품 예약을 납품예정일 + N일까지 유효로 본다(그 뒤엔 계산에서 제외)
//   · 오는중 유효일 = 마감 지난 제조사 요청서 잔여를 며칠까지 '올 것'으로 인정할지(3단의 B 구간)
//   · 확정형 유효일 = 목표일 지난 행사·대량 잔여를 며칠까지 청구할지. 없으면 무산 요청서가
//     매주 전량을 재청구하는 무한 루프가 된다.
// ─────────────────────────────────────────────

export const DEFAULT_RESERVE_GRACE_DAYS = 7;
export const DEFAULT_INBOUND_STALE_DAYS = 7;
export const DEFAULT_COMMITTED_STALE_DAYS = 14;

async function getNum(key: string, fallback: number, max = 120): Promise<number> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", key).maybeSingle();
    const n = Number(data?.value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(max, Math.round(n));
  } catch {
    return fallback;
  }
}

export async function getOpenLoadDays(): Promise<{ reserveGraceDays: number; inboundStaleDays: number; committedStaleDays: number }> {
  const [reserveGraceDays, inboundStaleDays, committedStaleDays] = await Promise.all([
    getNum("wholesale_reserve_grace_days", DEFAULT_RESERVE_GRACE_DAYS),
    getNum("inbound_stale_days", DEFAULT_INBOUND_STALE_DAYS),
    getNum("committed_stale_days", DEFAULT_COMMITTED_STALE_DAYS),
  ]);
  return { reserveGraceDays, inboundStaleDays, committedStaleDays };
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
