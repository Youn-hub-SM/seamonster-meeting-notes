// 리뷰 본문 정제 — 광고 카피 에이전트의 리뷰 읽기·주제 집계 공용(순수 함수, 서버·스크립트 어디서나).
//  2026-11-12 전체 리뷰 분석에서 확인한 것: 공식몰(카페24) 리뷰 게시판에는 고객이 쓰지 않은 글이 절반 넘게 섞여 있다.
//   ① 리뷰 앱(알파리뷰)이 별점에 맞춰 자동으로 채운 문구 — 2022~2026 원본 16,671건 중 2,865건
//   ② 스마트스토어 리뷰를 게시판으로 복사해 온 글('(YYYY-MM-DD 스마트스토어에서 등록된 구매후기)'로 끝남) — 6,220건.
//      스마트스토어 리뷰는 엑셀로 따로 받으므로 여기서 세면 두 번 센다.
//  이 둘을 빼지 않으면 '만족해요. 역시 생선은 씨몬스터!' 같은 자동 문구가 고객의 말로 집계된다.
//  ※ scripts/cafe24-review-sync.mjs 에 같은 규칙이 복사돼 있다(중계 서버는 TS 를 못 읽는다) — 고치면 둘 다 고친다.

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
// 리뷰 앱 자동 문구(이모지·끝의 'alpha_review' 표시를 뗀 뒤 정확히 같은 글)
const AUTO_TEMPLATES = new Set([
  "만족해요. 역시 생선은 씨몬스터! 감사합니다!",
  "수산물로 건강한 식단을 꾸리고 있어요! 감사합니다.",
  "나쁘지 않은 선택이었던 것 같아요",
  "무난한 상품이에요 감사합니다",
  "솔직히 조금 실망했어요. 다음 번엔 더 좋은 상품 부탁드려요",
  "운이 안 좋았던 건가.. 다음 번엔 더 좋은 상품으로 준비해주세요",
]);
const IMPORTED = /\(\d{4}-\d{2}-\d{2} 스마트스토어에서 등록된 구매후기\)\s*$/;
const ALPHA_TAIL = /\s*alpha_review\s*$/;

export const normalizeReview = (t: string): string => t.replace(EMOJI, "").replace(/\s+/g, " ").trim();

// 고객이 직접 쓴 리뷰면 다듬은 본문을, 자동 문구·복사본·빈 글이면 null 을 돌려준다.
export function customerReviewText(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t || IMPORTED.test(t)) return null;
  const body = t.replace(ALPHA_TAIL, "").trim();
  if (!body || AUTO_TEMPLATES.has(normalizeReview(body))) return null;
  return body;
}

// 설문 양식 리뷰(공식몰, 2026-06 중순~)의 고정 문구 걷어내기 — 주제를 세기 전에 거친다.
//  이 양식은 [고객유형] [사용유형] [구매이유] 칸을 고르고 정해진 질문('Q. 씨몬스터를 고르신 계기는?' 등)에 답하는 꼴이다.
//  고른 칸의 값('다이어트', '아침 식단', '건강을 위해' 등)과 질문 문장은 고객이 쓴 말이 아닌데 주제 검색식에 걸려
//  다이어트·아침 식사·건강 같은 주제를 부풀린다. 칸과 질문 문장만 지우고 고객이 쓴 답은 남긴다.
//  ※ 분석 때 쓴 식(집계 스크립트의 SV1·SV2)과 글자까지 같아야 건수가 맞는다.
const SURVEY_FIELD = /\[(고객유형|사용유형|구매이유)\]\s*(건강관리|다이어트|아이 반찬|간편식|시니어 식단|저녁 반찬|아침 식단|점심 도시락|손님 접대|술안주|저녁|점심|아침|간식|간편한 조리|건강을 위해|맛이 좋아서|신선한 재료|합리적 가격|지인 추천)?/g;
const SURVEY_QUESTION = /Q\.\s*[^?？\n]{2,30}[?？]/g;
export const stripSurveyForm = (t: string): string => t.replace(SURVEY_FIELD, " ").replace(SURVEY_QUESTION, " ");
