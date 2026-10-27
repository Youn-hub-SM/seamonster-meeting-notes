// 단골·블랙 고객 구분 — 화면(발주처리 카드·고객 등록)과 서버(fulfill-customers)가 같이 쓰는 값·색 지도(클라이언트 안전: 의존 없음).
//  색은 globals.css 시맨틱 세트만(디자인 시스템 §4): 블랙 = danger(주의), 단골 = success(챙김).
export type CustomerKind = "단골" | "블랙";
export const CUSTOMER_KINDS: readonly CustomerKind[] = ["단골", "블랙"];
export const CUSTOMER_KIND_COLOR: Record<CustomerKind, { bg: string; fg: string; border: string }> = {
  블랙: { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)", border: "var(--sm-danger-border)" },
  단골: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)", border: "var(--sm-success-border)" },
};
