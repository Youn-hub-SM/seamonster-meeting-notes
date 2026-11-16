// 주요 지표(/board) — 서버가 저장하는 묶음의 모양과, 화면이 그 묶음에서 기간·필터 값을 꺼내는 계산.
//  서버 전용 모듈을 불러오지 않는다(화면이 그대로 import).
//  묶음은 '날마다 한 칸' 배열(days 와 같은 길이, 과거 → 기준일)로 들고, 고른 기간과 그 직전 같은 길이 기간은 화면이 잘라 더한다.
//  비율(객단가·ROAS·전환율)은 날마다의 비율을 평균하지 않고 기간 합계끼리 나눈다.

export const BOARD_DAYS = 180;           // 기간 선택 범위(직전 기간 비교까지 이 안에서)
export const BOARD_VERSION = 2;

export type Fail = { ok: false; error: string };
export type NewRepeat = { total: number; newCust: number; repeatCust: number };
export type Nullable = (number | null)[];   // null = 그날 값을 아직 받지 못함

export type BoardSales = {
  ok: true;
  channels: { name: string; rev: number[]; orders: number[] }[];   // 180일 매출이 큰 순. 합계는 화면이 고른 채널로 더한다
};
export type BoardMeta = { ok: true; spend: number[]; value: number[]; purchases: number[]; impressions: number[]; clicks: number[] }; // clicks = 링크 클릭
export type BoardNaver = {
  ok: true;
  cost: Nullable; impressions: Nullable; clicks: Nullable;   // VAT 포함 광고비. null = 아직 받지 못한 날(다음 계산 때 이어 받는다)
  purchaseSales: number[]; purchases: number[];              // 구매 전환(장바구니 제외)
  purchaseOk: boolean;                                       // false = 최근 7일 구매 전환을 다 받지 못함(ROAS 미확정)
};
export type BoardGa = { ok: true; channels: { name: string; sessions: number[]; purchases: number[] }[]; truncated: boolean };
export type BoardSub = {
  ok: true; asOf: string;
  active: Nullable; pause: Nullable;                         // 그날 스냅샷이 없으면 null
  newCnt: number[]; cancelCnt: number[];                     // 신청 단위 상태 변화(관측일 기준)
  subRev: number[];                                          // 정기배송 결제 주문 매출
};
export type BoardVoc = { ok: true; counts: number[] };

export type BoardSnapshot = {
  v: typeof BOARD_VERSION;
  base: string;            // 기준일 = 매출이 들어온 마지막 날(어제까지)
  builtAt: string;         // 계산 시각(ISO)
  builtDay: string;        // 계산한 날(KST)
  salesFp: string;         // 매출 지문 — 달라지면 다시 계산
  days: string[];          // YYYY-MM-DD × BOARD_DAYS
  sales: BoardSales | Fail;
  meta: BoardMeta | Fail | null;    // null = 연결 안 됨
  naver: BoardNaver | Fail | null;
  ga: BoardGa | Fail | null;
  sub: BoardSub | Fail;
  voc: BoardVoc | Fail;
};

// 기간 상세(/api/board/detail) — 날마다 더할 수 없는 값(고유 고객 수)과 상품별 표
export type BoardProduct = { code: string; name: string; rev: number; qty: number; orders: number; prevRev: number };
export type BoardDetail = { from: string; to: string; products: BoardProduct[]; cust: { cur: NewRepeat; prev: NewRepeat } | null };

// ── 화면 계산 ──
export const shiftDay = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3) + 1;

/** 고른 기간의 배열 구간(i0~i1, 양끝 포함)과 직전 같은 길이 구간. 직전 구간이 묶음 밖이면 prev = null */
export type Span = { i0: number; i1: number; n: number; prev: { i0: number; i1: number } | null };
export function spanOf(days: string[], from: string, to: string): Span | null {
  const lo = days[0], hi = days[days.length - 1];
  const f = from < lo ? lo : from, t = to > hi ? hi : to;
  if (f > t) return null;
  const i0 = daysBetween(lo, f) - 1, i1 = daysBetween(lo, t) - 1, n = i1 - i0 + 1;
  return { i0, i1, n, prev: i0 - n >= 0 ? { i0: i0 - n, i1: i0 - 1 } : null };
}
export const sumOf = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (Number(x) || 0), 0);
export const cut = <T,>(xs: T[], i0: number, i1: number): T[] => xs.slice(i0, i1 + 1);
/** 기간 합계와 직전 기간 합계(직전이 없으면 prev = null) */
export function spanSum(xs: (number | null)[], sp: Span): { cur: number; prev: number | null } {
  return { cur: sumOf(cut(xs, sp.i0, sp.i1)), prev: sp.prev ? sumOf(cut(xs, sp.prev.i0, sp.prev.i1)) : null };
}
/** 여러 배열을 날마다 더한다 */
export function addSeries(list: (number | null)[][], len: number): number[] {
  const out = new Array<number>(len).fill(0);
  for (const xs of list) for (let i = 0; i < len; i++) out[i] += Number(xs[i]) || 0;
  return out;
}
/** 증감률(%) — 비교 값이 없거나 0 이하면 null */
export const pctChange = (cur: number | null, prev: number | null): number | null => (cur != null && prev != null && prev > 0 ? ((cur - prev) / prev) * 100 : null);
export const ratio = (a: number | null, b: number | null): number | null => (a != null && b != null && b > 0 ? a / b : null);
/** 스냅샷 배열에서 i 이하의 마지막 값(그날 값이 없으면 그 전 날) */
export function lastKnown(xs: Nullable, i: number): number | null {
  for (let k = Math.min(i, xs.length - 1); k >= 0; k--) if (xs[k] != null) return xs[k] as number;
  return null;
}

// ── 주제 보고서(2026-11-16) ── 주제 하나(예: 체험단)의 구매·광고 효율·페이지 전환·재구매를 한 화면에서 본다.
//  주제는 화면에서 만들지 않는다 — 대표와 같이 정한 정확한 대상을 아래 TOPICS 에 적는다(2026-11-16 대표: "자동 불러오기보다 같이 세팅").
//  말로 넓게 찾으면 섞인다: '체험단'이 든 상품이 172 말고도 셋(139·181·176) 있고, 172 는 이름이 한 번 바뀌었다.
//  주제는 두 가지다(2026-11-16): 상품 주문이 전환인 주제(productLike)와, 탈리 폼 신청이 전환인 주제(forms — 상품 주문·고객 집계를 하지 않는다).
export const TOPIC_VERSION = 7;
export type TopicDef = {
  id: string; name: string;
  basis: string;                      // 화면 위 집계 기준 줄에 보이는 대상 설명
  forms?: { apply: { id: string; label: string }; result: { id: string; label: string } | null };   // 탈리 폼 ID(신청·결과). result null = 결과 폼이 아직 정해지지 않음
  // 상품 주문형 주제의 결과 제출 탈리 폼(산 뒤 미션을 마치고 내는 폼) — 산 고객과 전화번호로 잇는다.
  //  scaleMax = 폼 안 설문 척도 문항의 만점(있으면 문항별 평균 점수를 보여 준다), scaleNames = [문항 제목에 든 구절, 화면에 쓸 짧은 이름]
  //  textNames = 의견 목록에 보여 줄 주관식 문항 [문항 제목에 든 구절, 화면에 쓸 짧은 이름] — 여기 적은 문항의 답만 묶음에 담는다(이름·연락처 문항은 적지 않는다)
  submit?: { id: string; label: string; scaleMax?: number; scaleNames?: [match: string, name: string][]; textNames?: [match: string, name: string][] };
  productLike: string[];              // 주문 상품명에 든 구절(그중 하나라도) — 그 상품만 잡히게 충분히 길게. 폼 신청형은 빈 배열
  landing: { label: string; paths: string[]; scroll: [label: string, event: string][] } | null;   // 랜딩 페이지 주소(정확히)와 스크롤 깊이 이벤트
  gaItemNames: string[];              // GA4 상품명(정확히) — 주문서 진입 수
  metaCampaignLike: string[];         // 메타 캠페인 이름에 든 말
};
export const TOPICS: TopicDef[] = [
  {
    // 이유식 체험단 = 공식몰 상품번호 172(이유식 생선 체험단). 페이지 seamonster.kr/baby, 메타 '이유식 체험단' 캠페인. 네이버 광고 없음.
    //  2026-11-16 이름을 '체험단' → '이유식 체험단'으로(대표 — 다이어트 챌린지와 나란히 놓이므로).
    //  결과 제출 폼 J9Lpyz(form.seamonster.kr/baby-submit, 2026-11-16 대표) = 이유식 기록 2건을 남긴 참여자가 내는 폼(휴대폰 번호·기록 링크 2개·선택 설문).
    //  선택 설문 = 1~8점 척도 8문항('설문 참여하고 소중한 의견 남기기'를 고른 사람만 답한다). 2026-11-17 대표: "설문 평균 점수 추이도 넣어줘".
    //  주관식 의견 = 참여 소감(모든 제출) + 설문의 아쉬운 점·다음 제품 희망. 2026-11-17 대표: "댓글창처럼 평점 우측에 쭉 스크롤되게".
    id: "trial", name: "이유식 체험단",
    basis: "공식몰 상품번호 172 주문 · 페이지 /baby · 탈리 제출 폼 · 메타 '이유식 체험단' 캠페인",
    submit: { id: "J9Lpyz", label: "체험단 제출", scaleMax: 8,
      scaleNames: [["배송 상태", "배송 상태"], ["지퍼백 포장", "지퍼백 포장"], ["조리 과정", "조리 과정"], ["조리 후 식감", "조리 후 식감"], ["조리 후 향", "조리 후 향"], ["가격 대비", "가격 대비 만족도"], ["아이의 반응", "아이의 반응"], ["다시 활용", "다시 쓸 의향"]],
      textNames: [["참여 소감", "참여 소감"], ["아쉬운 점", "아쉬운 점"], ["다음 이유식용 제품", "다음 제품 희망"]] },
    productLike: ["이유식 생선 체험단 패키지", "첫 생선일기 전용 패키지"],   // 172 의 지금 이름과 예전 이름
    landing: { label: "/baby", paths: ["/baby", "/baby/", "/baby/index.html"], scroll: [["25% 스크롤", "manualScrollDepth_25%"], ["50% 스크롤", "manualScrollDepth_50%"], ["75% 스크롤", "manualScrollDepth_75%"], ["95% 스크롤", "manualScrollDepth_95%"]] },
    gaItemNames: ["씨몬스터 이유식 생선 체험단 패키지", "우리 아이 첫 생선일기 전용 패키지"],
    metaCampaignLike: ["이유식 체험단"],
  },
  {
    // 다이어트 챌린지(2026-11-16 대표) = seamonster.kr/diet 에서 탈리 폼으로 신청 → 미션을 마치면 탈리 폼으로 결과 제출. 주로 메타 '다이어트 챌린지' 캠페인으로 들어온다.
    //  신청 폼 ArKkkW 는 /diet 페이지에 박혀 있는 폼이다. 결과 폼 q4r7Dd 는 미션을 마친 사람이 내는 '챌린지 인증' 폼이다(후기 링크 2개·연락처).
    //  상품이 정해져 있지 않다(선정된 뒤 원하는 제품을 산다) — 구매는 '신청한 사람이 신청한 날부터 산 주문'으로 본다(전화번호 → 고객 키).
    id: "diet", name: "다이어트 챌린지",
    basis: "페이지 /diet · 탈리 신청 폼·인증 폼 · 메타 '다이어트 챌린지' 캠페인",
    forms: { apply: { id: "ArKkkW", label: "챌린지 신청" }, result: { id: "q4r7Dd", label: "챌린지 인증" } },   // 인증 폼은 한 사람이 한 번 제출, 연락처 칸으로 신청과 잇는다(2026-11-16 대표)
    productLike: [],
    landing: { label: "/diet", paths: ["/diet", "/diet/", "/diet/index.html"], scroll: [["25% 스크롤", "manualScrollDepth_25%"], ["50% 스크롤", "manualScrollDepth_50%"], ["75% 스크롤", "manualScrollDepth_75%"], ["95% 스크롤", "manualScrollDepth_95%"]] },
    gaItemNames: [],
    metaCampaignLike: ["다이어트 챌린지"],
  },
];
export const TOPIC_REPEAT_DAYS = 30;   // 재구매율을 재는 창 — 처음 산 날부터 30일 안

export type TopicSales = {
  ok: true;
  channels: { name: string; rev: number[]; orders: number[]; qty: number[] }[];        // 날짜 × 채널(주문 건수는 주문 1건 키)
  items: { name: string; channel: string; rev: number[]; orders: number[]; qty: number[] }[]; // 날짜 × 채널 × '주문 상품명 / 옵션'
};
// 고객 — 그 상품을 '처음 산 날'로 센다(한 고객은 하루에만 들어가므로 기간으로 더해도 겹치지 않는다)
export type TopicCust = {
  ok: true;
  first: number[];     // 그날 처음 산 고객 수
  fresh: number[];     // 그중 씨몬스터 첫 주문이 그날인 고객(신규)
  conv: number[];      // 그중 그 뒤(다음 날부터 기준일까지) 다른 상품을 산 고객
  conv30: number[];    // 그중 30일 안에 다른 상품을 산 고객
  convRev: number[];   // 그 뒤 다른 상품 구매 매출
  after: { name: string; customers: number[]; rev: number[] }[];   // 그 뒤에 산 상품(처음 산 날 기준 배열) — 고객 수가 많은 15개
};
// 랜딩 페이지(GA4) — 단계는 세션 수(그 페이지에서 그 이벤트가 있었던 방문), 주문서 진입은 그 상품의 결제 시작 수량
export type TopicGa = {
  ok: true;
  visits: number[];                                   // 페이지를 본 방문
  scroll: { label: string; sessions: number[] }[];    // 스크롤 깊이 단계
  checkout: number[];                                 // 주문서 진입(GA4 상품 결제 시작)
  sources: { name: string; sessions: number[] }[];    // 소스/매체 + 기타
  truncated: boolean;
};
export type TopicMeta = {
  ok: true;
  ads: { id: string; campaign: string; adset: string; name: string; spend: number[]; impressions: number[]; clicks: number[]; purchases: number[]; value: number[] }[];
  campaignOnly: boolean;   // true = 광고 단위로 받지 못해 캠페인 단위로 받음
};
// 탈리 폼(신청·결과) — 날짜는 제출 시각의 한국 날짜. 사람은 전화번호로 센다(번호를 못 찾은 제출은 1건을 1명으로 — 구매·결과와 잇지 못한다).
//  묶음에는 건수만 담는다(이름·전화번호는 계산할 때만 쓰고 저장하지 않는다).
export type TopicForms = {
  ok: true;
  apply: number[];              // 그날 신청 제출 건수
  people: number[];             // 그날 처음 신청한 사람
  result: number[] | null;      // 그날 결과 제출 건수(null = 결과 폼이 정해지지 않음)
  done: number[];               // 신청일 기준 — 그날 처음 신청한 사람 중 지금까지 결과를 낸 사람
  buy: { ok: true; people: number[]; rev: number[] } | Fail;   // 신청일 기준 — 신청한 날부터 기준일까지 주문이 있는 사람과 그 매출(모든 채널)
  noPhone: number;              // 전화번호를 찾지 못한 신청 건수
  resultUnmatched: number;      // 결과 제출 중 신청한 사람과 잇지 못한 건수
  truncated: boolean;           // 제출이 많아 일부만 받음
};
// 결과 제출 폼(상품 주문형 주제) — 날짜는 제출 시각의 한국 날짜. 낸 사람은 전화번호 → 고객 키로 그 상품을 처음 산 날에 잇는다.
//  묶음에는 건수·점수와 주관식 의견 글만 담는다(이름·전화번호·링크는 담지 않는다).
export type TopicSubmit = {
  ok: true;
  count: number[];      // 그날 결과 제출 건수
  done: number[];       // 처음 산 날 기준 — 그날 처음 산 고객 중 지금까지 결과를 낸 사람
  unmatched: number;    // 전화번호가 없거나 그 상품을 산 기록을 찾지 못한 제출 건수
  truncated: boolean;   // 제출이 많아 일부만 받음
  survey: { label: string; sum: number[]; n: number[] }[];   // 설문 척도 문항(폼의 순서대로) — 그날 제출의 점수 합과 응답 수. 평균은 화면이 기간 합계끼리 나눈다
  surveyAnswered: number[];   // 그날 설문 척도 문항에 하나라도 답한 제출 건수
  // 주관식 의견 — 제출 하나가 한 줄(최근 것부터, TOPIC_OPINION_MAX 건까지). score = 그 제출의 척도 평균(설문에 답하지 않았으면 null)
  opinions: { day: string; score: number | null; parts: [name: string, text: string][] }[];
};
export const TOPIC_OPINION_MAX = 300;
export type TopicSnapshot = {
  v: typeof TOPIC_VERSION;
  id: string; cond: string;          // cond = 계산에 쓴 정의(달라지면 다시 계산)
  base: string; builtAt: string; builtDay: string;
  days: string[];
  sales: TopicSales | Fail | null;   // null = 폼 신청형 주제(상품 주문을 세지 않는다)
  cust: TopicCust | Fail | null;
  ga: TopicGa | Fail | null;         // null = 정의에 없음 또는 연결 안 됨
  meta: TopicMeta | Fail | null;
  forms: TopicForms | Fail | null;   // null = 상품 주문형 주제
  submit: TopicSubmit | Fail | null; // null = 결과 제출 폼이 없는 주제
};
