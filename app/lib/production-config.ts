// B2B 발주(생산대기·생산중)를 생산 계획(생산 일정·보드·제조사 요청서·재고/생산 조언)에
//  자동으로 끌어올지 여부. 재고 생산을 '도매 재고 생산 요청'으로 별도 운영하므로 꺼둠(2026-07 결정).
//  다시 켜려면 true. 발주의 생산상태 컬럼·값은 그대로 유지되므로 롤백은 이 플래그만 바꾸면 됨.
export const LINK_B2B_ORDERS_TO_PRODUCTION = false;

// 권장생산 목표 일수(예전 리드타임·발주 주기 설정 production_lead_days·production_cycle_days)는 2026-09-28 부터
//  생산 일정에서 계산한다 — app/lib/production-schedule.ts scheduleHorizon(). b2b_settings 의 두 키는 더 이상 읽지 않는다.
