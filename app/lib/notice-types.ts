// 공지 작성기 — 유형·항목 정의(데이터 구동).
//  화면(app/notice/page.tsx)과 서버(app/lib/notice.ts)는 이 파일의 배열만 읽는다.
//  유형을 추가하거나 항목을 바꾸는 일은 이 파일 안에서 끝난다(선례: app/lib/coupon-form.ts).
//  DB 없음 — 입력은 화면 상태, 결과는 복사해서 쓴다.

export type NoticeFieldKind = "text" | "textarea" | "select" | "date" | "number";

// 조건부 필수: values[key] 가 in 중 하나이거나(in), notIn 에 없으면(notIn) 필수.
//  notIn 에 "" 를 넣으면 '비어 있음'도 필수 아님으로 본다(선택 항목에 딸린 내용 칸).
export type NoticeCond = { key: string; in?: string[]; notIn?: string[] };

export type NoticeField = {
  key: string;
  label: string;
  kind: NoticeFieldKind;
  required: boolean;
  options?: string[];        // select 전용
  placeholder?: string;
  hint?: string;             // 카피 규칙 — 데이터 규칙이 아니면 비움
  defaultValue?: string;
  requiredIf?: NoticeCond;   // required=false 인 항목의 조건부 필수
};

export type NoticeAudience = "customer" | "b2b" | "both";

export type NoticeType = {
  key: string;
  label: string;
  audience: NoticeAudience;
  apology: boolean;          // true = 첫 문장이 사과
  fields: NoticeField[];
  desc?: string;             // 한 줄, 카피 규칙 — 집계 기준·데이터 규칙이 아니면 비움
};

export type NoticeValues = Record<string, string>;

// ── 채널과 글자 한도(0 = 한도 없음) ──
export const NOTICE_CHANNELS = ["알림톡·문자", "네이버 톡톡", "카카오 채널", "홈페이지 공지", "이메일"] as const;
export const CHANNEL_LIMITS: Record<string, number> = {
  "알림톡·문자": 1000,
  "네이버 톡톡": 1000,
  "카카오 채널": 1000,
  "홈페이지 공지": 0,
  "이메일": 0,
};
export function channelLimit(channel: string | undefined): number {
  return channel ? CHANNEL_LIMITS[channel] ?? 0 : 0;
}

// 필드당 값 길이 상한(서버·화면 공통)
export const NOTICE_VALUE_MAX = 2000;

export const AUDIENCE_LABEL: Record<Exclude<NoticeAudience, "both">, string> = { customer: "고객", b2b: "B2B" };

// ── 공통 항목(모든 유형 앞) — audience 는 유형의 audience 가 both 일 때만 노출 ──
const COMMON_AUDIENCE: NoticeField = { key: "audience", label: "대상", kind: "select", required: true, options: ["고객", "B2B"] };
export const COMMON_FIELDS: NoticeField[] = [
  { key: "channel", label: "채널", kind: "select", required: true, options: [...NOTICE_CHANNELS] },
  { key: "contact", label: "문의처", kind: "text", required: true, placeholder: "예: 카카오 채널 @씨몬스터 / 070-0000-0000" },
  { key: "sender", label: "발신명", kind: "text", required: true, defaultValue: "씨몬스터" },
];
// 공통 항목 키 — 화면이 유형을 바꿔도 공유하는 값(유형별 저장 대상이 아님). 화면은 이 집합을 import 한다.
export const COMMON_KEYS: ReadonlySet<string> = new Set([COMMON_AUDIENCE.key, ...COMMON_FIELDS.map((f) => f.key)]);

// 보상 select + 내용(보상이 '없음'이 아니면 필수) — 여러 유형이 같은 짝을 쓴다
const COMPENSATION_OPTIONS = ["없음", "적립금", "쿠폰", "배송비 환불", "기타"];
function compensationPair(required: boolean): NoticeField[] {
  return [
    { key: "compensation", label: "보상", kind: "select", required, options: COMPENSATION_OPTIONS },
    { key: "compensationDetail", label: "보상 내용", kind: "text", required: false, placeholder: "예: 적립금 2,000원 / 10% 쿠폰", requiredIf: { key: "compensation", notIn: ["", "없음"] } },
  ];
}

// ── 유형 6개 ──
export const NOTICE_TYPES: NoticeType[] = [
  {
    key: "delay", label: "배송 지연 사과", audience: "customer", apology: true,
    fields: [
      { key: "orders", label: "대상 주문", kind: "text", required: true, placeholder: "예: 10/10~10/12 주문" },
      { key: "product", label: "상품", kind: "text", required: true, placeholder: "예: 대구순살 전 상품" },
      { key: "originalShipDate", label: "원래 출고일", kind: "date", required: true },
      { key: "newShipDate", label: "변경 출고일", kind: "date", required: true },
      { key: "cause", label: "원인", kind: "select", required: true, options: ["주문 폭주", "생산 지연", "택배 사정", "기상", "시스템 오류", "기타"] },
      ...compensationPair(true),
      { key: "cancelable", label: "취소·환불 가능 여부", kind: "select", required: true, options: ["가능", "불가", "확인 중"] },
      { key: "nextNotice", label: "다음 안내 시점", kind: "text", required: false, placeholder: "예: 10/15 오후 알림톡 / 출고 당일 문자" },
    ],
  },
  {
    key: "soldout", label: "품절·발송 불가", audience: "customer", apology: true,
    fields: [
      { key: "product", label: "상품", kind: "text", required: true },
      { key: "reason", label: "사유", kind: "text", required: true, placeholder: "예: 원물 입고 지연으로 생산 불가" },
      { key: "alternative", label: "대안", kind: "select", required: true, options: ["대체 상품", "환불", "재입고 대기"] },
      { key: "altProduct", label: "대체 상품", kind: "text", required: false, placeholder: "예: 광어순살 300g (동일 가격)", requiredIf: { key: "alternative", in: ["대체 상품"] } },
      { key: "restockDate", label: "재입고 예정일", kind: "date", required: false },
      ...compensationPair(false),
    ],
  },
  {
    key: "quality", label: "품질 이슈 사과·회수", audience: "customer", apology: true,
    fields: [
      { key: "target", label: "대상", kind: "textarea", required: true, placeholder: "구매 기간 · 상품 · 로트" },
      { key: "issue", label: "문제 내용", kind: "textarea", required: true },
      { key: "safety", label: "섭취 안전 여부", kind: "select", required: true, options: ["섭취 가능", "섭취 중단 권고", "확인 중"] },
      { key: "action", label: "조치", kind: "select", required: true, options: ["환불", "교환", "회수", "환불 또는 교환"] },
      { key: "howTo", label: "신청 방법", kind: "textarea", required: true, placeholder: "예: 카카오 채널로 주문번호·사진 전송" },
      ...compensationPair(false),
    ],
  },
  {
    key: "price", label: "B2B 가격 인상", audience: "b2b", apology: true,
    fields: [
      { key: "items", label: "대상 품목", kind: "textarea", required: true },
      { key: "priceChange", label: "현 단가 → 신 단가 또는 인상률", kind: "textarea", required: true, placeholder: "예: 대구순살 1kg 18,000원 → 19,500원 (8.3%)" },
      { key: "effectiveDate", label: "적용일", kind: "date", required: true },
      { key: "reason", label: "사유", kind: "select", required: true, options: ["원물 시세", "환율", "인건비", "포장재", "기타"] },
      { key: "reasonDetail", label: "사유 내용", kind: "text", required: false, placeholder: "예: 대구 원물 시세 전년 대비 15% 상승", requiredIf: { key: "reason", in: ["기타"] } },
      { key: "orderRule", label: "적용 전 발주 처리 기준", kind: "text", required: true, placeholder: "예: 적용일 전 발주 건은 기존 단가" },
      { key: "grace", label: "유예 기간", kind: "text", required: false },
      { key: "moqChange", label: "최소 주문량 변경", kind: "text", required: false },
    ],
  },
  {
    key: "supply", label: "B2B 원물 수급 차질", audience: "b2b", apology: true,
    fields: [
      { key: "items", label: "품목", kind: "text", required: true },
      { key: "period", label: "예상 기간", kind: "text", required: true, placeholder: "예: 10/20~11/10" },
      { key: "allocation", label: "공급 가능 수량·배분 기준", kind: "textarea", required: true, placeholder: "예: 주당 200kg, 직전 3개월 발주량 비례 배분" },
      { key: "alternative", label: "대체안", kind: "textarea", required: true },
      { key: "normalizeAt", label: "정상화 예상 시점", kind: "text", required: true, placeholder: "예: 11월 둘째 주" },
      { key: "priceImpact", label: "가격 영향", kind: "text", required: false },
    ],
  },
  {
    key: "general", label: "일반 공지", audience: "both", apology: false,
    fields: [
      { key: "title", label: "제목", kind: "text", required: true },
      { key: "period", label: "기간", kind: "text", required: true, placeholder: "예: 10/3~10/5 (추석 연휴)" },
      { key: "body", label: "내용", kind: "textarea", required: true },
      { key: "scope", label: "영향 범위", kind: "text", required: true, placeholder: "예: 전 채널 주문 · 정기배송 포함" },
      { key: "orderCutoff", label: "주문 마감 시점", kind: "text", required: false, placeholder: "예: 10/2 14:00 결제분까지 연휴 전 출고" },
    ],
  },
];

export function findNoticeType(key: string | undefined): NoticeType | null {
  return NOTICE_TYPES.find((t) => t.key === key) ?? null;
}

// 유형 하나가 화면에 보여 주고 서버가 검증하는 항목 전체(공통 → 유형 항목 순).
export function fieldsFor(type: NoticeType): NoticeField[] {
  const common = type.audience === "both" ? [COMMON_AUDIENCE, ...COMMON_FIELDS] : COMMON_FIELDS;
  return [...common, ...type.fields];
}

// 유형의 초기값(defaultValue 가 있는 항목만)
export function defaultValuesFor(type: NoticeType): NoticeValues {
  const out: NoticeValues = {};
  for (const f of fieldsFor(type)) if (f.defaultValue !== undefined) out[f.key] = f.defaultValue;
  return out;
}

function condMet(c: NoticeCond, values: NoticeValues): boolean {
  const v = (values[c.key] ?? "").trim();
  if (c.in) return c.in.includes(v);
  if (c.notIn) return !c.notIn.includes(v);
  return false;
}

export function isNoticeFieldRequired(f: NoticeField, values: NoticeValues): boolean {
  if (f.required) return true;
  return !!f.requiredIf && condMet(f.requiredIf, values);
}

// 비어 있는 필수 항목(조건부 포함). 화면은 개수로 버튼을 잠그고, 서버는 라벨로 400 을 만든다.
export function missingRequired(type: NoticeType, values: NoticeValues): NoticeField[] {
  return fieldsFor(type).filter((f) => isNoticeFieldRequired(f, values) && !(values[f.key] ?? "").trim());
}

// 받는 사람 라벨 — 유형이 both 면 입력의 '대상', 아니면 유형이 정한 쪽.
export function audienceOf(type: NoticeType, values: NoticeValues): string {
  if (type.audience === "both") return (values.audience ?? "").trim() || "고객";
  return AUDIENCE_LABEL[type.audience];
}
