// VOC(고객의 소리) 공통 상수·타입 — 클라이언트/서버 공용(여기엔 DB 코드 없음).

export const VOC_SOURCES = ["직접입력", "설문", "리뷰", "기타"] as const;
export const VOC_CATEGORIES = ["배송", "품질", "포장", "누락", "오배송", "가시", "이물", "기타"] as const;
export const VOC_STATUSES = ["대기", "진행중", "완료"] as const;
export const VOC_SENTIMENTS = ["긍정", "부정", "중립"] as const;
export const VOC_BUYER_TYPES = ["첫구매", "재구매"] as const;          // 구매자 구분
export const VOC_COMP_TYPES = ["환불", "반품", "교환·재발송", "추가보상", "부분환불", "없음"] as const; // 보상유형

export type VocSource = (typeof VOC_SOURCES)[number];
export type VocCategory = (typeof VOC_CATEGORIES)[number];
export type VocStatus = (typeof VOC_STATUSES)[number];
export type VocSentiment = (typeof VOC_SENTIMENTS)[number];
export type VocBuyerType = (typeof VOC_BUYER_TYPES)[number];
export type VocCompType = (typeof VOC_COMP_TYPES)[number];

// 보상유형별 손해/보상 금액 자동계산. 단가는 상품 마스터(판매가·원가)에서.
//  환불·반품 → 판매가×수량, 교환·재발송 → 원가×수량, 없음 → 0,
//  추가보상·부분환불 → null(자동계산 없음, 직접 입력).
export const VOC_COMP_MANUAL = new Set<string>(["추가보상", "부분환불"]);
export function autoLoss(compType: string, qty: number, salePrice: number, costPrice: number): number | null {
  const n = Math.max(1, Math.round(qty || 1));
  switch (compType) {
    case "환불":
    case "반품": return Math.round((salePrice || 0) * n);
    case "교환·재발송": return Math.round((costPrice || 0) * n);
    case "없음": return 0;
    default: return null; // 추가보상·부분환불
  }
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
  loss_amount: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// 상태별 색 (목록 뱃지)
export const VOC_STATUS_COLOR: Record<VocStatus, { bg: string; fg: string }> = {
  대기: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  진행중: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  완료: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
};
