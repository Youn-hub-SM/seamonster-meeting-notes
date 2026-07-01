// 쿠폰 등록 요청서 — 채널별 단계별 설문 정의 + 요청서 텍스트 빌더.
//  목적: MD가 쿠폰 등록 시 요청이 제각각이라 실수가 잦음 → 요청자가 단계별로 선택하면
//  일관된 요청서 텍스트가 나오고, MD는 이를 체크리스트 삼아 설정한다(휴먼리스크↓).
//  DB 없음(텍스트만 생성해 복사 → Flow 태스크로 붙여넣기).

export type CouponShow = { key: string; in: string[] };
export type CouponField = {
  key: string;
  label: string;
  type: "radio" | "checkbox" | "text" | "number" | "textarea";
  options?: string[];
  required?: boolean;
  placeholder?: string;
  help?: string;            // 안내/주의(요청자·MD 공통 참고)
  default?: string | string[];
  showIf?: CouponShow;      // 특정 답변일 때만 노출
  suffix?: string;          // 값 뒤 단위(원·개 등)
};
export type CouponStep = { title: string; desc?: string; note?: string; fields: CouponField[] };
export type CouponChannel = { key: string; label: string; intro: string; steps: CouponStep[]; checklist: string[]; cautions?: string[] };

const OFFICIAL: CouponChannel = {
  key: "official",
  label: "공식몰",
  intro: "카페24 공식몰 쿠폰. 아래를 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "쿠폰 이름", desc: "고객에게 보여질 이름", fields: [
      { key: "name", label: "쿠폰 이름", type: "text", required: true, placeholder: "예: 삼치데이 15% 할인쿠폰" },
    ] },
    { title: "혜택", desc: "어떤 혜택을 줄까요?", fields: [
      { key: "benefit", label: "혜택 구분", type: "radio", required: true, options: ["할인금액", "할인율", "적립금액", "적립율", "기본 배송비 할인", "전체 배송비 할인", "즉시 적립"], help: "주로 쓰는 건 할인금액·할인율·기본 배송비 할인" },
      { key: "benefitValue", label: "할인/적립 값", type: "text", placeholder: "예: 15% 또는 1,000원", showIf: { key: "benefit", in: ["할인금액", "할인율", "적립금액", "적립율", "기본 배송비 할인"] } },
      { key: "maxDiscount", label: "최대 할인(적립)금액", type: "number", suffix: "원", showIf: { key: "benefit", in: ["할인율", "적립율", "기본 배송비 할인"] }, help: "⚠️ 할인율/적립율은 최대 금액을 반드시 입력. 0원이면 제한 없이 적용됩니다." },
    ] },
    { title: "발급 방법", desc: "고객이 어떻게 받나요?", fields: [
      { key: "issue", label: "발급 구분", type: "radio", required: true, options: ["대상자 지정 발급", "조건부 자동 발급", "고객 다운로드 발급", "정기 자동 발급"], help: "대상자 지정=특정 회원 / 조건부=가입·후기 등 조건 / 다운로드=고객이 직접 / 정기=주기 자동" },
      { key: "exposeTime", label: "노출 시점", type: "radio", options: ["즉시 노출", "지정한 시점에 노출"], showIf: { key: "issue", in: ["대상자 지정 발급", "고객 다운로드 발급"] } },
      { key: "detailExpose", label: "상품 상세페이지 노출", type: "radio", options: ["노출함", "노출 안함"], showIf: { key: "issue", in: ["고객 다운로드 발급"] }, help: "⚠️ 고객 다운로드 발급이면 필수! 비공개·메시지 전용 쿠폰은 '노출 안함'." },
    ] },
    { title: "사용 기간", fields: [
      { key: "period", label: "사용 기간", type: "radio", required: true, options: ["기간 설정", "쿠폰 발급일 기준", "쿠폰 발급 당월 말일까지"] },
      { key: "periodDetail", label: "기간 상세", type: "text", placeholder: "예: 2025.03.05 09:00~2025.03.08 00:00 / 발급일로부터 7일", showIf: { key: "period", in: ["기간 설정", "쿠폰 발급일 기준"] } },
    ] },
    { title: "적용 범위", desc: "어디에 적용할까요?", fields: [
      { key: "applyScope", label: "적용 범위", type: "radio", required: true, options: ["주문서 쿠폰", "상품쿠폰"], help: "주문서=적용상품 합계에 할인(권장) / 상품=적용상품 1개에만" },
      { key: "applyProduct", label: "쿠폰 적용 상품", type: "radio", required: true, options: ["전체 상품", "특정 상품", "제외 상품"] },
      { key: "productNames", label: "적용/제외 상품명", type: "text", placeholder: "예: 삼치순살 1kg, 더 간편한 삼치순살", showIf: { key: "applyProduct", in: ["특정 상품", "제외 상품"] } },
      { key: "applyCategory", label: "쿠폰 적용 분류", type: "radio", options: ["모두 적용", "선택한 분류 적용", "선택한 분류 제외하고 적용"], default: "모두 적용" },
      { key: "categories", label: "카테고리 선택", type: "checkbox", options: ["순살생선", "더 간편한 렌지용", "이유식 생선", "새우,오징어", "3분 생선찜기", "업소용 대용량"], showIf: { key: "applyCategory", in: ["선택한 분류 적용", "선택한 분류 제외하고 적용"] } },
      { key: "minAmountType", label: "사용 가능 기준 금액", type: "radio", options: ["제한없음", "주문금액기준", "상품금액기준"], default: "제한없음" },
      { key: "minAmount", label: "기준 금액", type: "number", suffix: "원 이상", showIf: { key: "minAmountType", in: ["주문금액기준", "상품금액기준"] } },
    ] },
    { title: "추가 설정", desc: "대부분 기본값 그대로 두면 됩니다", fields: [
      { key: "device", label: "사용 범위", type: "checkbox", options: ["PC 쇼핑몰", "모바일 쇼핑몰"], default: ["PC 쇼핑몰", "모바일 쇼핑몰"] },
      { key: "calcBase", label: "적용 계산 기준", type: "radio", options: ["할인 적용 전 결제 금액", "할인 적용 후 결제 금액"], default: "할인 적용 전 결제 금액" },
      { key: "sameCoupon", label: "주문서당 쿠폰 사용 개수", type: "number", suffix: "개", default: "1" },
      { key: "payMethod", label: "사용 가능 결제수단", type: "radio", options: ["제한없음", "결제수단 선택"], default: "제한없음" },
    ] },
  ],
  checklist: ["쿠폰 이름 확인", "혜택 구분 확인", "발급구분 확인", "사용기간 확인", "적용범위 확인", "적용상품 확인", "최소 구매금액 확인", "최대 할인금액 입력 확인", "상품 상세페이지 노출 여부 확인(고객 다운로드 발급인 경우)"],
  cautions: ["할인율/적립율은 최대 할인(적립)금액을 반드시 입력(0원=제한없음).", "고객 다운로드 발급이면 상품 상세페이지 노출 여부를 반드시 확인."],
};

const NAVER: CouponChannel = {
  key: "naver",
  label: "네이버",
  intro: "네이버 스마트스토어 쿠폰/포인트. 아래를 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "혜택 이름", fields: [
      { key: "name", label: "혜택 이름", type: "text", required: true, placeholder: "최대 30자 (예: 새해맞이 전 제품 10% 할인)" },
    ] },
    { title: "타겟팅 대상", desc: "누구에게 제공하나요?", fields: [
      { key: "target", label: "타겟팅 대상", type: "radio", required: true, options: ["전체 고객", "첫구매고객", "재구매고객", "알림받기", "라운지 고객", "타겟팅"], help: "알림받기=메시지 발송용에 자주 사용 / 타겟팅=미리 만든 고객 그룹" },
    ] },
    { title: "혜택", desc: "어떤 혜택을 줄까요?", fields: [
      { key: "benefitKind", label: "혜택 종류", type: "radio", required: true, options: ["쿠폰", "포인트"] },
      { key: "couponKind", label: "쿠폰 종류", type: "radio", options: ["상품 중복 할인", "장바구니 할인", "배송비 할인"], showIf: { key: "benefitKind", in: ["쿠폰"] } },
      { key: "issue", label: "발급 방법", type: "radio", required: true, options: ["다운로드", "고객에게 즉시 발급"] },
      { key: "issueLimit", label: "발급 건수", type: "radio", options: ["제한 없음", "제한 있음"], default: "제한 없음" },
      { key: "discount", label: "할인 설정", type: "text", placeholder: "예: 10% 또는 3,000원", required: true },
      { key: "maxDiscount", label: "최대 할인금액(할인율 선택 시)", type: "number", suffix: "원", help: "할인율이면 필수 입력." },
    ] },
    { title: "기간", fields: [
      { key: "issuePeriod", label: "혜택 발급기간", type: "text", required: true, placeholder: "예: 2026.01.07 14:00~2026.01.22 23:59" },
      { key: "validType", label: "쿠폰 유효기간", type: "radio", required: true, options: ["기간으로 설정", "발급일 기준으로 설정"] },
      { key: "validDetail", label: "유효기간 상세", type: "text", placeholder: "기간(예: 1/7~1/22) 또는 발급일 기준 일수(예: 14일)" },
    ] },
    { title: "적용", desc: "어디에 적용할까요?", fields: [
      { key: "applyProduct", label: "혜택 상품 지정", type: "radio", required: true, options: ["내스토어 상품 전체", "카테고리 선택", "상품 선택"] },
      { key: "productNames", label: "카테고리/상품명", type: "text", placeholder: "예: 오징어살 100g", showIf: { key: "applyProduct", in: ["카테고리 선택", "상품 선택"] } },
      { key: "minAmount", label: "최소주문금액(선택)", type: "number", suffix: "원 이상" },
    ] },
  ],
  checklist: ["타겟팅 대상 확인", "쿠폰 종류 확인", "할인 방식 확인", "혜택 상품 지정 확인", "발급기간 / 유효기간 확인", "최대 할인금액 입력 확인"],
  cautions: ["할인율이면 최대 할인금액을 반드시 입력."],
};

const TALK: CouponChannel = {
  key: "talk",
  label: "톡스토어",
  intro: "카카오 톡스토어 쿠폰. 아래를 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "쿠폰명", fields: [
      { key: "name", label: "쿠폰명", type: "text", required: true, placeholder: "예: 톡채널 친구쿠폰" },
    ] },
    { title: "혜택", desc: "어떤 쿠폰을 줄까요?", fields: [
      { key: "couponKind", label: "쿠폰 종류", type: "radio", required: true, options: ["상품 할인쿠폰", "장바구니 할인쿠폰"] },
      { key: "discount", label: "할인 금액", type: "text", required: true, placeholder: "예: 10% 또는 500원" },
      { key: "maxDiscount", label: "최대 할인금액(할인율 선택 시)", type: "number", suffix: "원" },
    ] },
    { title: "발급 대상", desc: "누구에게 제공하나요?", fields: [
      { key: "target", label: "쿠폰 발급 대상", type: "radio", required: true, options: ["전체 고객", "첫구매 고객", "재구매 고객"] },
      { key: "friend", label: "채널 친구 여부", type: "radio", options: ["설정안함", "설정함(톡채널 친구)"], default: "설정함(톡채널 친구)", help: "기본은 '설정함' — 톡채널 친구 추가 유도용." },
    ] },
    { title: "적용", desc: "어디에 적용할까요?", fields: [
      { key: "applyTarget", label: "쿠폰 적용 대상", type: "radio", required: true, options: ["스토어 전체 상품", "카테고리 선택", "상품 선택", "기획전 선택"] },
      { key: "productNames", label: "카테고리/상품/기획전명", type: "text", showIf: { key: "applyTarget", in: ["카테고리 선택", "상품 선택", "기획전 선택"] } },
      { key: "minAmount", label: "최소 주문금액", type: "number", suffix: "원 이상" },
    ] },
    { title: "기간·발급", fields: [
      { key: "issuePeriod", label: "쿠폰 발급 기간", type: "text", required: true, placeholder: "예: 2025.12.29 00:00~2026.12.31 23:59" },
      { key: "validType", label: "쿠폰 유효기간", type: "radio", required: true, options: ["발급일 기준 설정", "종료일 직접 설정"] },
      { key: "validDetail", label: "유효기간 상세", type: "text", placeholder: "발급일 기준 일수(예: 3일) 또는 종료일" },
      { key: "issueQty", label: "발급 수량", type: "radio", required: true, options: ["특정 개수", "무제한"] },
      { key: "issueQtyN", label: "발급 개수", type: "number", suffix: "개", showIf: { key: "issueQty", in: ["특정 개수"] } },
      { key: "display", label: "쿠폰 전시 여부", type: "radio", options: ["전시함", "전시안함"], default: "전시함" },
    ] },
  ],
  checklist: ["쿠폰명 확인", "쿠폰 종류·할인 확인", "발급 대상·채널 친구 여부 확인", "적용 대상 확인", "발급기간 / 유효기간 확인", "발급 수량·전시 여부 확인"],
  cautions: ["채널 친구 여부는 기본 '설정함(톡채널 친구)'."],
};

export const COUPON_CHANNELS: CouponChannel[] = [OFFICIAL, NAVER, TALK];

export type Answers = Record<string, string | string[]>;

export function isFieldShown(f: CouponField, answers: Answers): boolean {
  if (!f.showIf) return true;
  const v = answers[f.showIf.key];
  return typeof v === "string" && f.showIf.in.includes(v);
}

// 요청서 텍스트 생성 — Flow 태스크에 붙여넣을 형태.
export function buildRequestText(ch: CouponChannel, answers: Answers, meta: { requester?: string; date: string }): string {
  const lines: string[] = [`[쿠폰 등록 요청서 · ${ch.label}]`, ""];
  for (const step of ch.steps) {
    for (const f of step.fields) {
      if (!isFieldShown(f, answers)) continue;
      const v = answers[f.key];
      const val = Array.isArray(v) ? v.join(", ") : (v ?? "").toString().trim();
      if (!val) continue;
      lines.push(`· ${f.label} : ${val}${f.suffix ? ` ${f.suffix}` : ""}`);
    }
  }
  lines.push("", "── MD 확인 체크리스트 ──", ...ch.checklist.map((c) => `□ ${c}`));
  if (ch.cautions?.length) lines.push("", ...ch.cautions.map((c) => `⚠️ ${c}`));
  lines.push("", `요청자: ${meta.requester || "________"}   요청일: ${meta.date}`);
  return lines.join("\n");
}
