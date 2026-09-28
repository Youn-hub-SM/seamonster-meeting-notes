// 생산 일정 기본값 — 화면(클라이언트)과 서버가 같이 쓰는 순수 계산(DB·알림 의존 없음).
//  생산 일정(영업일, 2026-09-29 대표 정정): 작성 D → 컨펌·제출 D+1 → 생산 시작 D+3 → 생산 마감 D+7 → 판매 가능 D+8.
//  (09-28 에 적용한 D+5·D+9·D+10 은 영업일 기준이 아니었다 — 대표가 영업일 기준 값으로 정정)
//  제조사(재고 보충) 요청서의 기본 생산시작일·생산종료일이 이 값이다. 도매 납품은 종전 기본(+7영업일) 유지.
import { addBusinessDays } from "./business-days";
import { CONFIRMED_PURPOSES, type PrPurpose } from "./wholesale-production";

export const PROD_START_BDAYS = 3;
export const PROD_DUE_BDAYS = 7;
export const WHOLESALE_DUE_BDAYS = 7;

export function kstTodayIso(): string { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }

// 용도별 기본 종료일 — 확정형(프로모션·도매 대량)은 사람이 정하는 날이라 기본값 없음(null).
export function defaultDueDate(purpose: PrPurpose, requestDate: string): string | null {
  if (CONFIRMED_PURPOSES.includes(purpose)) return null;
  return addBusinessDays(requestDate, purpose === "재고 보충" ? PROD_DUE_BDAYS : WHOLESALE_DUE_BDAYS);
}
export function defaultProdStart(requestDate: string): string { return addBusinessDays(requestDate, PROD_START_BDAYS); }

// ─────────────────────────────────────────────
// 권장생산 목표 기간 — 위 일정에서 나온다(2026-09-28 대표 요청: 권장량에 D-day 일정 반영).
//  요청서는 매주 수요일(AI 초안) 한 번 나간다. 오늘 시킨 물량은 판매 가능일(D+8 영업일)에야 팔 수 있고,
//  그다음 물량은 다음 요청일(오늘 다음의 첫 수요일 — 월·화엔 이번 주 수요일) 요청분의 판매 가능일에 온다. 그래서
//   목표 = 평상시 하루 출고 × (오늘 → 다음 요청분 판매 가능일) 일수   ← 권장생산(주문 후 재고 수준)
//   부족 기준 = 평상시 하루 출고 × (오늘 → 오늘 요청분 판매 가능일) 일수 ← 지금 시켜도 판매 가능일 전에 바닥나는가
//  공휴일이 없는 주: 수요일 기준 목표 19일 · 부족 기준 12일(월·화는 10일). 요일이 지날수록 목표 일수가 하루씩 줄어
//  (재고도 하루치씩 줄므로) 같은 주 안에서는 권장이 거의 그대로이고, 다음 수요일에 새 주기가 시작된다.
// ─────────────────────────────────────────────
export const SELLABLE_BDAYS = 8;   // 작성 D → 판매 가능 D+8 영업일
export const DRAFT_WEEKDAY = 3;    // 주간 요청서(AI 초안) 요일 — 수요일(0=일)

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400e3);

/** fromIso 다음(그날 제외) 첫 요청 요일(수요일). */
export function nextDraftDate(fromIso: string): string {
  const d = new Date(fromIso + "T00:00:00Z");
  const add = ((DRAFT_WEEKDAY - d.getUTCDay() + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

export type ScheduleHorizon = {
  today: string;
  sellable: string;      // 오늘 요청하면 판매 가능한 날(D+8 영업일)
  nextDraft: string;     // 다음 요청일(오늘 다음의 첫 수요일)
  nextSellable: string;  // 다음 요청분의 판매 가능일
  leadDays: number;      // 오늘 → sellable (달력 일수) — 부족·요청 마감 기준
  cycleDays: number;     // sellable → nextSellable (달력 일수)
  horizonDays: number;   // 오늘 → nextSellable (달력 일수) — 권장생산 목표 기준
};

/** 오늘(KST 날짜) 기준 권장 목표 기간. 공휴일은 business-days 의 KR_HOLIDAYS 를 따른다. */
export function scheduleHorizon(today: string = kstTodayIso()): ScheduleHorizon {
  const sellable = addBusinessDays(today, SELLABLE_BDAYS);
  const nextDraft = nextDraftDate(today);
  const nextSellable = addBusinessDays(nextDraft, SELLABLE_BDAYS);
  const leadDays = Math.max(1, daysBetween(today, sellable));
  const horizonDays = Math.max(leadDays, daysBetween(today, nextSellable));
  return { today, sellable, nextDraft, nextSellable, leadDays, cycleDays: horizonDays - leadDays, horizonDays };
}
