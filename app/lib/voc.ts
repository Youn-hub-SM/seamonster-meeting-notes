// VOC(고객의 소리) 공통 상수·타입 — 클라이언트/서버 공용(여기엔 DB 코드 없음).

export const VOC_SOURCES = ["직접입력", "설문", "리뷰", "기타"] as const;
export const VOC_CATEGORIES = ["불만", "문의", "요청", "칭찬", "제안", "기타"] as const;
export const VOC_STATUSES = ["접수", "처리중", "완료", "보류"] as const;
export const VOC_SENTIMENTS = ["긍정", "부정", "중립"] as const;

export type VocSource = (typeof VOC_SOURCES)[number];
export type VocCategory = (typeof VOC_CATEGORIES)[number];
export type VocStatus = (typeof VOC_STATUSES)[number];
export type VocSentiment = (typeof VOC_SENTIMENTS)[number];

export interface Voc {
  id: string;
  received_at: string;        // YYYY-MM-DD
  source: VocSource;
  channel: string | null;
  customer: string | null;
  product: string | null;
  category: VocCategory;
  content: string;
  sentiment: VocSentiment | null;
  status: VocStatus;
  assignee: string | null;
  resolution: string | null;
  loss_amount: number;
  created_at: string;
}

// 상태별 색 (목록 뱃지)
export const VOC_STATUS_COLOR: Record<VocStatus, { bg: string; fg: string }> = {
  접수: { bg: "#FFF4E0", fg: "#B86E00" },
  처리중: { bg: "#E0F0FF", fg: "#0A66C2" },
  완료: { bg: "#E0F5E5", fg: "#22863A" },
  보류: { bg: "#EEEEEE", fg: "#666666" },
};
