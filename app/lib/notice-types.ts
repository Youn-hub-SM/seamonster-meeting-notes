// 공지 작성기 — 유형·항목 정의(데이터 구동).
//  2026-10-13 대표 피드백으로 '칸 나눈 폼' 은 없어졌다. 직원은 공지할 내용을 자유롭게 쓰고,
//  AI 가 유형을 판단해 아래 항목을 글에서 추출한다. 이 파일의 유형·항목은 그때의 '필수 항목 기준' 이다:
//   · 서버(app/lib/notice.ts)는 유형·항목 목록을 출력 규칙 프롬프트에 넣고, 추출값을 항목 기준으로 정리한다.
//   · 화면(app/notice/page.tsx)은 빠진 필수·선택 항목을 '추가로 넣으면 좋은 것' 으로 권장한다.
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

// 필드당 값 길이 상한(서버·화면 공통) — '공지할 내용' 자유 입력도 같은 상한
export const NOTICE_VALUE_MAX = 2000;

export const AUDIENCE_LABEL: Record<Exclude<NoticeAudience, "both">, string> = { customer: "고객", b2b: "B2B" };

// ── 공통 항목(모든 유형 앞) ──
//  audience: 유형의 audience 가 both 일 때만 — AI 가 글에서 '대상' 도 판단한다.
//  channel : 화면 select 로 받는다(AI 추출·권장 대상 아님 → promptFieldsFor 가 뺀다).
//  contact·sender: 유형 항목처럼 추출·권장. contact 는 필수, sender 는 선택(비면 '씨몬스터').
const COMMON_AUDIENCE: NoticeField = { key: "audience", label: "대상", kind: "select", required: true, options: ["고객", "B2B"] };
export const CHANNEL_KEY = "channel";
export const COMMON_FIELDS: NoticeField[] = [
  { key: CHANNEL_KEY, label: "채널", kind: "select", required: true, options: [...NOTICE_CHANNELS] },
  { key: "contact", label: "문의처", kind: "text", required: true, placeholder: "예: 카카오 채널 @씨몬스터 / 070-0000-0000" },
  { key: "sender", label: "발신명", kind: "text", required: false, defaultValue: "씨몬스터" },
];

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
    key: "soldout", label: "상품 품절·발송 불가", audience: "customer", apology: true,
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

// 유형 하나의 항목 전체(공통 → 유형 항목 순).
export function fieldsFor(type: NoticeType): NoticeField[] {
  const common = type.audience === "both" ? [COMMON_AUDIENCE, ...COMMON_FIELDS] : COMMON_FIELDS;
  return [...common, ...type.fields];
}

// AI 가 글에서 추출하고 화면이 '빠진 항목' 으로 권장하는 항목 — 채널만 뺀다(채널은 화면 select).
export function promptFieldsFor(type: NoticeType): NoticeField[] {
  return fieldsFor(type).filter((f) => f.key !== CHANNEL_KEY);
}

// 키로 항목 찾기 — 그 유형의 추출·권장 항목 안에서(채널 제외).
//  유형은 필수: 추가 입력(extras)은 유형이 정해진 뒤에만 받는다. 같은 키가 유형마다 다른 항목인 경우가 있어
//  (alternative: 품절 select '대안' / 수급 textarea '대체안', reason: 품절 text / 가격 select) 유형 없이 찾으면 엉뚱한 항목이 잡힌다.
export function findFieldByKey(key: string, type: NoticeType): NoticeField | null {
  return promptFieldsFor(type).find((f) => f.key === key) ?? null;
}

// 직원 추가 입력(extras)을 유형 `to` 로 보낼 때 남길 것 — 화면이 서버에 보내기 전·응답 뒤에 정리한다.
//  · `to` 에 있는 키만. 이전 유형 `from` 에 같은 키가 다른 kind 로 있었으면 버린다(위 findFieldByKey 의 충돌 예).
//  · select 는 선택지 안의 값만(선택지 밖은 서버가 버려 바뀌는 게 없다).
//  · 빈 값은 버린다 — 화면은 '비웠다' 표시로 "" 를 들고 있지만 서버는 빈 값을 '추출값 유지' 로 보므로 보낼 것이 없다.
//  결과 순서는 `to` 의 항목 순서(프롬프트 [추가 입력] 줄 순서).
export function carryExtras(extras: NoticeValues, from: NoticeType | null, to: NoticeType): NoticeValues {
  const fromFields = from ? promptFieldsFor(from) : [];
  const out: NoticeValues = {};
  for (const nf of promptFieldsFor(to)) {
    const v = (extras[nf.key] ?? "").trim();
    if (!v) continue;
    const of = fromFields.find((f) => f.key === nf.key);
    if (of && of.kind !== nf.kind) continue;
    if (nf.kind === "select" && !nf.options?.includes(v)) continue;
    out[nf.key] = v;
  }
  return out;
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

// 비어 있는 필수 항목(조건부 포함). fields 를 주면 그 안에서만 본다(서버는 promptFieldsFor 를 준다).
export function missingRequired(type: NoticeType, values: NoticeValues, fields: NoticeField[] = fieldsFor(type)): NoticeField[] {
  return fields.filter((f) => isNoticeFieldRequired(f, values) && !(values[f.key] ?? "").trim());
}

// 비어 있는 선택 항목(지금 값 기준으로 필수가 아닌 것) — 화면의 '선택 항목 N개'.
export function emptyOptional(type: NoticeType, values: NoticeValues, fields: NoticeField[] = fieldsFor(type)): NoticeField[] {
  return fields.filter((f) => !isNoticeFieldRequired(f, values) && !(values[f.key] ?? "").trim());
}

// 화면에 돌려주는 항목 요약 — 입력칸을 그릴 만큼만(hint 는 입력 형식 예시: hint 가 없으면 placeholder).
export type NoticeFieldInfo = { key: string; label: string; kind: NoticeFieldKind; options?: string[]; hint?: string };
export function fieldInfo(f: NoticeField): NoticeFieldInfo {
  const out: NoticeFieldInfo = { key: f.key, label: f.label, kind: f.kind };
  if (f.options) out.options = [...f.options];
  const hint = f.hint ?? f.placeholder;
  if (hint) out.hint = hint;
  return out;
}

// 받는 사람 라벨 — 유형이 both 면 입력의 '대상', 아니면 유형이 정한 쪽.
export function audienceOf(type: NoticeType, values: NoticeValues): string {
  if (type.audience === "both") return (values.audience ?? "").trim() || "고객";
  return AUDIENCE_LABEL[type.audience];
}
