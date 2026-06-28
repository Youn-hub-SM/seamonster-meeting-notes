// VOC(고객의 소리) 공통 상수·타입 — 클라이언트/서버 공용(여기엔 DB 코드 없음).

export const VOC_SOURCES = ["직접입력", "설문", "리뷰", "기타"] as const;
export const VOC_CATEGORIES = ["배송", "품질", "포장", "누락", "오배송", "가시", "이물", "기타"] as const;
export const VOC_STATUSES = ["대기", "진행중", "완료"] as const;
export const VOC_SENTIMENTS = ["긍정", "부정", "중립"] as const;

export type VocSource = (typeof VOC_SOURCES)[number];
export type VocCategory = (typeof VOC_CATEGORIES)[number];
export type VocStatus = (typeof VOC_STATUSES)[number];
export type VocSentiment = (typeof VOC_SENTIMENTS)[number];

export interface Voc {
  id: string;
  received_at: string;        // YYYY-MM-DD 접수일
  channel: string | null;     // 접수채널
  source: VocSource;          // 수집 방식
  customer: string | null;    // 고객명
  purchase_date: string | null;  // 구매일
  purchase_place: string | null; // 구매처
  product: string | null;     // 구매상품
  category: VocCategory;      // 클레임 유형
  content: string;            // 상세내용
  resolution: string | null;  // 처리내용
  cause: string | null;       // 원인
  status: VocStatus;          // 상태
  improvement: string | null; // 개선 필요사항
  assignee: string | null;
  sentiment: VocSentiment | null;
  loss_amount: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// 상태별 색 (목록 뱃지)
export const VOC_STATUS_COLOR: Record<VocStatus, { bg: string; fg: string }> = {
  대기: { bg: "#FFF4E0", fg: "#B86E00" },
  진행중: { bg: "#E0F0FF", fg: "#0A66C2" },
  완료: { bg: "#E0F5E5", fg: "#22863A" },
};
