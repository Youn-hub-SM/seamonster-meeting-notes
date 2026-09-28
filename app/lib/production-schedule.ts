// 생산 일정 기본값 — 화면(클라이언트)과 서버가 같이 쓰는 순수 계산(DB·알림 의존 없음).
//  생산 일정(영업일, 2026-09-28 대표 확정): 작성 D → 컨펌·제출 D+1 → 생산 시작 D+5 → 생산 마감 D+9 → 판매 가능 D+10.
//  제조사(재고 보충) 요청서의 기본 생산시작일·생산종료일이 이 값이다. 도매 납품은 종전 기본(+7영업일) 유지.
import { addBusinessDays } from "./business-days";
import { CONFIRMED_PURPOSES, type PrPurpose } from "./wholesale-production";

export const PROD_START_BDAYS = 5;
export const PROD_DUE_BDAYS = 9;
export const WHOLESALE_DUE_BDAYS = 7;

export function kstTodayIso(): string { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }

// 용도별 기본 종료일 — 확정형(프로모션·도매 대량)은 사람이 정하는 날이라 기본값 없음(null).
export function defaultDueDate(purpose: PrPurpose, requestDate: string): string | null {
  if (CONFIRMED_PURPOSES.includes(purpose)) return null;
  return addBusinessDays(requestDate, purpose === "재고 보충" ? PROD_DUE_BDAYS : WHOLESALE_DUE_BDAYS);
}
export function defaultProdStart(requestDate: string): string { return addBusinessDays(requestDate, PROD_START_BDAYS); }
