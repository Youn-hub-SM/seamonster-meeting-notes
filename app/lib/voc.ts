// VOC(고객의 소리) 공통 상수·타입 — 클라이언트/서버 공용(여기엔 DB 코드 없음).
import { iceboxCost, deliveryCost, coolingCost, suggestBoxes, seasonForDate } from "./b2b-margin";

export const VOC_SOURCES = ["직접입력", "설문", "리뷰", "기타"] as const;
export const VOC_CATEGORIES = ["배송", "품질", "포장", "누락", "오배송", "가시", "이물", "기타"] as const;
export const VOC_STATUSES = ["접수", "응대·개선중", "개선완료"] as const;
export const VOC_SENTIMENTS = ["긍정", "부정", "중립"] as const;
export const VOC_BUYER_TYPES = ["첫구매", "재구매"] as const;          // 구매자 구분
export const VOC_COMP_TYPES = ["환불", "반품", "교환·재발송", "추가보상", "부분환불", "없음"] as const; // 보상유형
export const VOC_FAULTS = ["제조사", "물류", "자사", "고객", "미분류"] as const; // 손해 귀책(정산 분리)

export type VocSource = (typeof VOC_SOURCES)[number];
export type VocCategory = (typeof VOC_CATEGORIES)[number];
export type VocStatus = (typeof VOC_STATUSES)[number];
export type VocSentiment = (typeof VOC_SENTIMENTS)[number];
export type VocBuyerType = (typeof VOC_BUYER_TYPES)[number];
export type VocCompType = (typeof VOC_COMP_TYPES)[number];
export type VocFault = (typeof VOC_FAULTS)[number];

// 클레임유형 → 귀책 1차 추정(등록 시 기본값·백필 기준과 동일). 사람이 보정 가능.
export const FAULT_BY_CATEGORY: Record<string, VocFault> = {
  품질: "제조사", 가시: "제조사", 이물: "제조사", 포장: "제조사",
  배송: "물류", 오배송: "물류", 누락: "자사", 기타: "미분류",
};
export function suggestFault(category: string): VocFault {
  return FAULT_BY_CATEGORY[category] || "미분류";
}
// 제조사에 청구 가능한 귀책(개선요청서 청구액 산정)
export const VOC_FAULT_CLAIMABLE = new Set<string>(["제조사"]);
// 자사가 떠안는 부담 귀책
export const VOC_FAULT_BURDEN = new Set<string>(["물류", "자사"]);

// 보상유형별 손해/보상 금액 자동계산.
//  손해 = 이미 나간 비용이 날아가는 것 = 상품원가(cost_price)×수량 + 배송원가.
//  배송원가는 부피·계절 기준(b2b-margin: 아이스박스+운반비+보냉비) 1배송분.
//  환불·반품·교환·재발송 → 원가+배송, 없음 → 0, 추가보상·부분환불 → 직접입력.
export const VOC_COMP_MANUAL = new Set<string>(["추가보상", "부분환불"]);

export interface VocLossInput {
  compType: string;
  qty: number;
  costPrice: number;    // 상품 1개 원가(cost_price)
  volumeKg: number;     // 상품 1개 부피(kg). 0이면 배송원가 제외
  receivedAt?: string | null; // 계절 판정용(없으면 fallbackMonth)
  fallbackMonth: number;      // 현재월(1~12)
}
export interface VocLossResult {
  auto: boolean;        // 자동계산 유형 여부(추가보상·부분환불=false)
  amount: number;       // 손해 합계
  productCost: number;  // 상품원가 합
  shipping: number;     // 배송원가
  boxes: number;        // 배송 박스 수
}
export function computeVocLoss(i: VocLossInput): VocLossResult {
  const zero = { productCost: 0, shipping: 0, boxes: 0 };
  if (i.compType === "없음") return { auto: true, amount: 0, ...zero };
  if (VOC_COMP_MANUAL.has(i.compType)) return { auto: false, amount: 0, ...zero };
  const qty = Math.max(1, Math.round(i.qty || 1));
  const productCost = Math.round((Number(i.costPrice) || 0) * qty);
  const vol = (Number(i.volumeKg) || 0) * qty;
  let shipping = 0, boxes = 0;
  if (vol > 0) {
    boxes = suggestBoxes(vol);
    const perBox = vol / boxes;
    const season = seasonForDate(i.receivedAt, i.fallbackMonth);
    shipping = Math.round(boxes * (iceboxCost(perBox) + deliveryCost(perBox) + coolingCost(season)));
  }
  return { auto: true, amount: productCost + shipping, productCost, shipping, boxes };
}

export interface Voc {
  id: string;
  received_at: string;        // YYYY-MM-DD 접수일
  channel: string | null;     // 접수채널
  source: VocSource;          // 수집 방식
  customer: string | null;    // 고객명
  purchase_date: string | null;  // 구매일
  production_date: string | null; // 제품 생산일(제조사 배치 추적)
  purchase_place: string | null; // 구매처
  product: string | null;     // 구매상품
  buyer_type: VocBuyerType | null; // 구매자 구분(첫/재구매)
  photos: string[];           // 첨부 사진 공개 URL
  category: VocCategory;      // 클레임 유형
  content: string;            // 상세내용
  resolution: string | null;  // 처리내용
  cause: string | null;       // 원인
  status: VocStatus;          // 상태
  improvement: string | null; // 개선 필요사항
  customer_note: string | null; // 고객 특이사항
  assignee: string | null;
  sentiment: VocSentiment | null;
  comp_type: VocCompType;     // 보상유형
  comp_qty: number;           // 보상 수량
  fault: VocFault;            // 손해 귀책(제조사/물류/자사/고객/미분류)
  loss_amount: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// 상태별 색 (목록 뱃지)
export const VOC_STATUS_COLOR: Record<VocStatus, { bg: string; fg: string }> = {
  접수: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  "응대·개선중": { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  개선완료: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
};
