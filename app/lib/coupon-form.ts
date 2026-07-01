// 쿠폰 등록 요청서 — 채널별 단계별 설문 정의 + 요청서 텍스트 빌더.
//  목적: MD가 쿠폰 등록 시 요청이 제각각이라 실수가 잦음 → 요청자가 단계별로 선택하면
//  일관된 요청서 텍스트가 나오고, MD는 이를 체크리스트 삼아 설정한다(휴먼리스크↓).
//  DB 없음(텍스트만 생성해 복사 → Flow 태스크로 붙여넣기).
//  구조 재설계(2026-07): 조건부 노출 AND/OR, 달력+시간(datetime-range)/발급일기준(int-days) 필드,
//  요청서 3블록(핵심 요약·상세 설정·위험 확인) + 조건부 체크리스트.

// ── 조건부 노출/필수: 단일 + AND(all) + OR(any) 재귀 ──
export type CouponCond =
  | { key: string; in: string[] }   // 단일: answers[key]가 in 중 하나(체크박스는 교집합)
  | { all: CouponCond[] }           // AND
  | { any: CouponCond[] };          // OR

// ── 필드 값 타입: 문자열/다중선택 배열 + 기간(datetime-range) 객체 ──
export type DateRange = { start: string; end: string };   // "YYYY-MM-DDTHH:mm" ×2
export type AnswerVal = string | string[] | DateRange;
export type Answers = Record<string, AnswerVal>;

export type CouponFieldType =
  | "radio" | "checkbox" | "text" | "number" | "textarea"
  | "datetime-range"   // 달력+시간(시작~종료)
  | "int-days";        // 발급일 기준 N일(숫자 + 프리셋 칩, suffix "일")

export type CouponField = {
  key: string;
  label: string;
  type: CouponFieldType;
  options?: string[];
  required?: boolean;
  requiredIf?: CouponCond;   // 조건부 필수(노출됐고 이 조건이면 필수)
  placeholder?: string;
  help?: string;             // 안내/주의("⚠️" 포함 시 경고색)
  default?: string | string[];
  showIf?: CouponCond;       // 이 조건일 때만 노출
  suffix?: string;           // number/int-days 단위(원·개·일 등)
  presets?: number[];        // int-days 프리셋 칩(예: [7,14,30])
  critical?: boolean;        // 요청서 '핵심 요약' 블록으로 승격
  emptyText?: string;        // 값이 비어도 이 문구로 출력(누락 vs 무제한 구분)
};
export type CouponStep = { title: string; desc?: string; note?: string; collapsible?: boolean; fields: CouponField[] };
export type CouponChannel = { key: string; label: string; intro: string; steps: CouponStep[]; checklist: string[] };

// ───────────────────────── 공식몰(카페24) ─────────────────────────
const OFFICIAL: CouponChannel = {
  key: "official",
  label: "공식몰",
  intro: "카페24 공식몰 쿠폰. 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "쿠폰 이름", desc: "고객·MD 목록에서 보일 이름", fields: [
      { key: "name", label: "쿠폰 이름", type: "text", required: true, critical: true, placeholder: "예: [삼치데이] 15% 할인 (2507)", help: "월/차수 태그를 넣으면 중복발급을 막고 목록에서 쉽게 구분됩니다." },
    ] },
    { title: "혜택", desc: "어떤 혜택을 줄까요?", fields: [
      { key: "benefit", label: "혜택 구분", type: "radio", required: true, critical: true, options: ["할인금액", "할인율", "적립금액", "적립율", "기본 배송비 할인", "전체 배송비 할인", "즉시 적립"], help: "자주 쓰는 건 할인율·할인금액·기본 배송비 할인." },
      { key: "benefitValue", label: "할인/적립 값", type: "text", placeholder: "예: 15% 또는 1,000원", showIf: { key: "benefit", in: ["할인금액", "할인율", "적립금액", "적립율"] }, requiredIf: { key: "benefit", in: ["할인금액", "할인율", "적립금액", "적립율"] } },
      { key: "maxDiscount", label: "최대 할인(적립)금액", type: "number", suffix: "원", critical: true,
        showIf: { any: [{ key: "benefit", in: ["할인율", "적립율"] }, { key: "shipFeeType", in: ["할인율 지정"] }] },
        requiredIf: { any: [{ key: "benefit", in: ["할인율", "적립율"] }, { key: "shipFeeType", in: ["할인율 지정"] }] },
        help: "⚠️ 할인율/적립율은 상한을 반드시 지정하세요. 0원 = 제한 없이 전액 적용(사고 위험)." },
      { key: "shipFeeType", label: "배송비 할인 방식", type: "radio", options: ["전액 무료", "할인금액 지정", "할인율 지정"], default: "전액 무료", showIf: { key: "benefit", in: ["기본 배송비 할인"] }, requiredIf: { key: "benefit", in: ["기본 배송비 할인"] } },
      { key: "shipFeeValue", label: "배송비 할인 값", type: "text", placeholder: "예: 2,500원 / 50%", showIf: { key: "shipFeeType", in: ["할인금액 지정", "할인율 지정"] }, requiredIf: { key: "shipFeeType", in: ["할인금액 지정", "할인율 지정"] } },
      { key: "shipRegion", label: "지역별 추가배송비", type: "radio", options: ["포함", "미포함"], default: "미포함", showIf: { key: "benefit", in: ["기본 배송비 할인"] }, help: "도서산간(제주·섬) 추가배송비까지 할인할지. 보통 '미포함'." },
    ] },
    { title: "발급 방법", desc: "고객이 어떻게 받나요?", fields: [
      { key: "issue", label: "발급 구분", type: "radio", required: true, critical: true, options: ["대상자 지정 발급", "조건부 자동 발급", "고객 다운로드 발급", "정기 자동 발급"], help: "대상자 지정=특정 회원 / 조건부=가입·후기 등 조건 / 다운로드=고객이 직접 / 정기=주기 자동." },
      { key: "targetMember", label: "대상 회원", type: "radio", options: ["전체회원", "특정회원(등급/그룹)"], showIf: { key: "issue", in: ["대상자 지정 발급"] }, requiredIf: { key: "issue", in: ["대상자 지정 발급"] } },
      { key: "targetMemberList", label: "특정 회원 대상", type: "textarea", placeholder: "회원등급 / 그룹 / 회원 ID", showIf: { all: [{ key: "issue", in: ["대상자 지정 발급"] }, { key: "targetMember", in: ["특정회원(등급/그룹)"] }] }, requiredIf: { all: [{ key: "issue", in: ["대상자 지정 발급"] }, { key: "targetMember", in: ["특정회원(등급/그룹)"] }] } },
      { key: "autoCond", label: "발급 조건", type: "checkbox", options: ["회원가입", "배송완료", "생일", "후기작성", "주문완료", "첫구매", "구매수량 도달", "등급 상향"], showIf: { key: "issue", in: ["조건부 자동 발급"] }, requiredIf: { key: "issue", in: ["조건부 자동 발급"] }, help: "쿠폰이 자동 발급될 트리거(보통 1개)." },
      { key: "dlBase", label: "다운로드 대상", type: "radio", options: ["회원등급 지정", "미구매기간"], showIf: { key: "issue", in: ["고객 다운로드 발급"] }, requiredIf: { key: "issue", in: ["고객 다운로드 발급"] } },
      { key: "dlUnbuyMonths", label: "미구매 기간", type: "number", suffix: "개월", placeholder: "1~12", showIf: { key: "dlBase", in: ["미구매기간"] }, requiredIf: { key: "dlBase", in: ["미구매기간"] } },
      { key: "dlRedup", label: "동일인 재발급", type: "radio", options: ["불가", "가능"], default: "불가", showIf: { key: "issue", in: ["고객 다운로드 발급"] }, help: "⚠️ '가능'이면 1인이 여러 번 수령 → 예산 초과 위험. 반복 이벤트만 '가능'." },
      { key: "regularGrade", label: "대상 회원등급", type: "text", placeholder: "예: 우수회원", showIf: { key: "issue", in: ["정기 자동 발급"] }, requiredIf: { key: "issue", in: ["정기 자동 발급"] } },
      { key: "regularCycle", label: "정기 발급 주기", type: "radio", options: ["매일", "3일", "1주", "1개월", "3개월", "6개월"], showIf: { key: "issue", in: ["정기 자동 발급"] }, requiredIf: { key: "issue", in: ["정기 자동 발급"] } },
    ] },
    { title: "노출·전시", desc: "고객 화면에 언제/어떻게 보이나요?", fields: [
      { key: "exposeTime", label: "노출 시점", type: "radio", options: ["즉시 노출", "지정 기간에만 노출"], default: "즉시 노출", showIf: { any: [{ key: "issue", in: ["대상자 지정 발급"] }, { key: "issue", in: ["고객 다운로드 발급"] }] } },
      { key: "exposePeriod", label: "노출 기간", type: "datetime-range", critical: true, showIf: { key: "exposeTime", in: ["지정 기간에만 노출"] }, requiredIf: { key: "exposeTime", in: ["지정 기간에만 노출"] }, help: "이 기간에만 화면/다운로드 영역에 보입니다. 아래 '사용 기간'과는 다릅니다." },
      { key: "detailExpose", label: "상품 상세페이지 노출", type: "radio", options: ["노출함", "노출 안함"], critical: true, showIf: { key: "issue", in: ["고객 다운로드 발급"] }, requiredIf: { key: "issue", in: ["고객 다운로드 발급"] }, help: "⚠️ 다운로드 발급이면 필수. 비공개·문자 전용 쿠폰이면 '노출 안함'." },
    ] },
    { title: "사용 기간", desc: "고객이 언제까지 쓸 수 있나요?", fields: [
      { key: "period", label: "사용 기간 방식", type: "radio", required: true, critical: true, options: ["기간 설정", "발급일 기준", "발급 당월 말일까지"], default: "발급일 기준" },
      { key: "usePeriodRange", label: "사용 기간", type: "datetime-range", critical: true, showIf: { key: "period", in: ["기간 설정"] }, requiredIf: { key: "period", in: ["기간 설정"] } },
      { key: "usePeriodDays", label: "발급일로부터", type: "int-days", suffix: "일", presets: [7, 14, 30, 60], default: "7", showIf: { key: "period", in: ["발급일 기준"] }, requiredIf: { key: "period", in: ["발급일 기준"] }, help: "발급 순간부터 N일 뒤 만료." },
    ] },
    { title: "적용 범위", desc: "어디에 적용할까요?", fields: [
      { key: "applyScope", label: "적용 범위", type: "radio", required: true, options: ["주문서 쿠폰", "상품쿠폰"], default: "주문서 쿠폰", help: "주문서=적용상품 합계에 할인(권장) / 상품=적용상품 1개 단위." },
      { key: "applyProduct", label: "쿠폰 적용 상품", type: "radio", required: true, options: ["전체 상품", "특정 상품", "제외 상품"], default: "전체 상품" },
      { key: "productNames", label: "적용/제외 상품명", type: "textarea", placeholder: "상품명을 줄바꿈으로 입력", showIf: { key: "applyProduct", in: ["특정 상품", "제외 상품"] }, requiredIf: { key: "applyProduct", in: ["특정 상품", "제외 상품"] } },
      { key: "applyCategory", label: "쿠폰 적용 분류", type: "radio", options: ["모두 적용", "선택한 분류 적용", "선택한 분류 제외"], default: "모두 적용" },
      { key: "categories", label: "카테고리 선택", type: "checkbox", options: ["순살생선", "더 간편한 렌지용", "이유식 생선", "새우·오징어", "3분 생선찜기", "업소용 대용량"], showIf: { key: "applyCategory", in: ["선택한 분류 적용", "선택한 분류 제외"] }, requiredIf: { key: "applyCategory", in: ["선택한 분류 적용", "선택한 분류 제외"] } },
      { key: "minAmountType", label: "사용 기준 금액", type: "radio", options: ["제한없음", "주문금액 기준", "상품금액 기준"], default: "제한없음" },
      { key: "minAmount", label: "기준 금액", type: "number", suffix: "원 이상", showIf: { key: "minAmountType", in: ["주문금액 기준", "상품금액 기준"] }, requiredIf: { key: "minAmountType", in: ["주문금액 기준", "상품금액 기준"] } },
    ] },
    { title: "추가 설정", desc: "특별한 요청이 없으면 그대로 두세요", note: "대부분 기본값 그대로 두면 됩니다. 조정이 필요할 때만 펼치세요.", collapsible: true, fields: [
      { key: "device", label: "사용 범위", type: "checkbox", options: ["PC 쇼핑몰", "모바일 쇼핑몰"], default: ["PC 쇼핑몰", "모바일 쇼핑몰"] },
      { key: "calcBase", label: "적용 계산 기준", type: "radio", options: ["할인 전 결제금액", "할인 후 결제금액"], default: "할인 전 결제금액" },
      { key: "sameCoupon", label: "주문서당 사용 개수", type: "number", suffix: "개", default: "1" },
      { key: "payMethod", label: "사용 가능 결제수단", type: "radio", options: ["제한없음", "결제수단 선택"], default: "제한없음" },
      { key: "payMethodList", label: "선택 결제수단", type: "text", placeholder: "예: 신용카드, 무통장", showIf: { key: "payMethod", in: ["결제수단 선택"] }, requiredIf: { key: "payMethod", in: ["결제수단 선택"] } },
    ] },
  ],
  checklist: ["쿠폰 이름·혜택 값이 요청과 일치하는지", "발급 방법·대상 확인", "사용 기간의 시작·종료 '시각'까지 확인", "적용 범위·상품/분류 확인"],
};

// ───────────────────────── 네이버(스마트스토어) ─────────────────────────
const NAVER: CouponChannel = {
  key: "naver",
  label: "네이버",
  intro: "네이버 스마트스토어 쿠폰/포인트. 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "혜택 이름", fields: [
      { key: "name", label: "혜택 이름", type: "text", required: true, critical: true, placeholder: "최대 30자 (예: 새해맞이 10% 할인)", help: "⚠️ 최대 30자." },
    ] },
    { title: "타겟팅 대상", desc: "누구에게 제공하나요?", fields: [
      { key: "target", label: "타겟팅 대상", type: "radio", required: true, critical: true, options: ["전체 고객", "첫구매고객", "재구매고객", "알림받기", "라운지 고객", "타겟팅"], default: "전체 고객", help: "알림받기=메시지 발송용 / 타겟팅=미리 만든 고객 그룹." },
      { key: "custType", label: "고객유형 제한", type: "radio", options: ["제한없음", "네이버플러스 멤버십"], default: "제한없음", showIf: { key: "target", in: ["전체 고객"] } },
      { key: "targetGroup", label: "타겟팅 그룹 정보", type: "textarea", placeholder: "그룹명 / 거래기간 / 거래정보 / 관심여부 / 예상 고객수", showIf: { key: "target", in: ["타겟팅"] }, requiredIf: { key: "target", in: ["타겟팅"] } },
    ] },
    { title: "혜택", desc: "어떤 혜택을 줄까요?", fields: [
      { key: "benefitKind", label: "혜택 종류", type: "radio", required: true, critical: true, options: ["쿠폰", "포인트"], default: "쿠폰" },
      { key: "couponKind", label: "쿠폰 종류", type: "radio", options: ["상품 중복 할인", "장바구니 할인", "배송비 할인"], showIf: { key: "benefitKind", in: ["쿠폰"] }, requiredIf: { key: "benefitKind", in: ["쿠폰"] } },
      { key: "issue", label: "발급 방법", type: "radio", required: true, options: ["다운로드", "고객에게 즉시 발급"], default: "다운로드" },
      { key: "issueLimit", label: "발급 건수", type: "radio", options: ["제한 없음", "제한 있음"], default: "제한 없음" },
      { key: "issueLimitN", label: "발급 건수 제한", type: "number", suffix: "건", showIf: { key: "issueLimit", in: ["제한 있음"] }, requiredIf: { key: "issueLimit", in: ["제한 있음"] } },
      { key: "discountUnit", label: "할인 단위", type: "radio", required: true, options: ["할인율(%)", "할인액(원)"], help: "단위를 먼저 고르면 아래 입력칸이 바뀝니다." },
      { key: "discountPct", label: "할인율", type: "number", suffix: "%", critical: true, showIf: { key: "discountUnit", in: ["할인율(%)"] }, requiredIf: { key: "discountUnit", in: ["할인율(%)"] } },
      { key: "discountAmt", label: "할인액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["할인액(원)"] }, requiredIf: { key: "discountUnit", in: ["할인액(원)"] } },
      { key: "maxDiscount", label: "최대 할인금액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["할인율(%)"] }, requiredIf: { key: "discountUnit", in: ["할인율(%)"] }, help: "⚠️ 할인율(%)이면 필수. 0원 = 무제한." },
      { key: "minAmount", label: "최소주문금액(선택)", type: "number", suffix: "원 이상", help: "배송비 할인 쿠폰은 보통 최소금액을 설정합니다." },
    ] },
    { title: "기간", desc: "언제 발급하고 언제까지 유효한가요?", fields: [
      { key: "issuePeriod", label: "혜택 발급기간", type: "datetime-range", required: true, critical: true },
      { key: "validType", label: "쿠폰 유효기간", type: "radio", required: true, options: ["기간으로 설정", "발급일 기준"], default: "발급일 기준" },
      { key: "validRange", label: "유효기간", type: "datetime-range", critical: true, showIf: { key: "validType", in: ["기간으로 설정"] }, requiredIf: { key: "validType", in: ["기간으로 설정"] } },
      { key: "validDays", label: "발급일로부터", type: "int-days", suffix: "일", presets: [7, 14, 30], default: "14", showIf: { key: "validType", in: ["발급일 기준"] }, requiredIf: { key: "validType", in: ["발급일 기준"] } },
    ] },
    { title: "적용", desc: "어디에 적용할까요?", fields: [
      { key: "applyProduct", label: "혜택 상품 지정", type: "radio", required: true, options: ["내스토어 상품 전체", "카테고리 선택", "상품 선택"], default: "내스토어 상품 전체" },
      { key: "productNames", label: "카테고리/상품명", type: "textarea", placeholder: "예: 오징어살 100g", showIf: { key: "applyProduct", in: ["카테고리 선택", "상품 선택"] }, requiredIf: { key: "applyProduct", in: ["카테고리 선택", "상품 선택"] } },
    ] },
  ],
  checklist: ["혜택 이름 30자 이내 확인", "타겟팅 대상 확인", "혜택 종류·할인 단위/값 확인", "발급기간·유효기간의 시작·종료 '시각' 확인", "적용 상품 확인"],
};

// ───────────────────────── 톡스토어(카카오) ─────────────────────────
const TALK: CouponChannel = {
  key: "talk",
  label: "톡스토어",
  intro: "카카오 톡스토어 쿠폰. 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "쿠폰명", fields: [
      { key: "name", label: "쿠폰명", type: "text", required: true, critical: true, placeholder: "예: 톡채널 친구쿠폰" },
    ] },
    { title: "혜택", desc: "어떤 쿠폰을 줄까요?", fields: [
      { key: "couponKind", label: "쿠폰 종류", type: "radio", required: true, critical: true, options: ["상품 할인쿠폰", "장바구니 할인쿠폰"], default: "상품 할인쿠폰" },
      { key: "discountUnit", label: "할인 단위", type: "radio", required: true, options: ["할인율(%)", "할인액(원)"], help: "단위를 먼저 고르면 아래 입력칸이 바뀝니다." },
      { key: "discountPct", label: "할인율", type: "number", suffix: "%", critical: true, showIf: { key: "discountUnit", in: ["할인율(%)"] }, requiredIf: { key: "discountUnit", in: ["할인율(%)"] } },
      { key: "discountAmt", label: "할인액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["할인액(원)"] }, requiredIf: { key: "discountUnit", in: ["할인액(원)"] } },
      { key: "maxDiscount", label: "최대 할인금액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["할인율(%)"] }, requiredIf: { key: "discountUnit", in: ["할인율(%)"] }, help: "⚠️ 할인율(%)이면 필수. 0원 = 무제한." },
      { key: "minAmount", label: "최소 주문금액", type: "number", suffix: "원 이상" },
    ] },
    { title: "발급 대상", desc: "누구에게 제공하나요?", fields: [
      { key: "target", label: "쿠폰 발급 대상", type: "radio", required: true, critical: true, options: ["전체 고객", "첫구매 고객", "재구매 고객"], default: "전체 고객" },
      { key: "friend", label: "채널 친구 여부", type: "radio", options: ["설정안함", "설정함(톡채널 친구)"], default: "설정함(톡채널 친구)", help: "기본 '설정함' — 톡채널 친구 추가 유도용." },
    ] },
    { title: "적용", desc: "어디에 적용할까요?", fields: [
      { key: "applyTarget", label: "쿠폰 적용 대상", type: "radio", required: true, options: ["스토어 전체 상품", "카테고리 선택", "상품 선택", "기획전 선택"], default: "스토어 전체 상품" },
      { key: "productNames", label: "카테고리/상품/기획전명", type: "textarea", placeholder: "이름을 줄바꿈으로 입력", showIf: { key: "applyTarget", in: ["카테고리 선택", "상품 선택", "기획전 선택"] }, requiredIf: { key: "applyTarget", in: ["카테고리 선택", "상품 선택", "기획전 선택"] } },
    ] },
    { title: "기간·발급·전시", fields: [
      { key: "issuePeriod", label: "쿠폰 발급 기간", type: "datetime-range", required: true, critical: true },
      { key: "validType", label: "쿠폰 유효기간", type: "radio", required: true, options: ["발급일 기준", "종료일 직접 설정"], default: "발급일 기준" },
      { key: "validDays", label: "발급일로부터", type: "int-days", suffix: "일", presets: [7, 14, 30], default: "7", showIf: { key: "validType", in: ["발급일 기준"] }, requiredIf: { key: "validType", in: ["발급일 기준"] } },
      { key: "validEnd", label: "유효 종료일", type: "datetime-range", critical: true, showIf: { key: "validType", in: ["종료일 직접 설정"] }, requiredIf: { key: "validType", in: ["종료일 직접 설정"] }, help: "종료 시점이 핵심입니다. 시작은 발급기간 시작과 동일하게 처리됩니다." },
      { key: "issueQty", label: "발급 수량", type: "radio", required: true, options: ["특정 개수", "무제한"], default: "무제한" },
      { key: "issueQtyN", label: "발급 개수", type: "number", suffix: "개", showIf: { key: "issueQty", in: ["특정 개수"] }, requiredIf: { key: "issueQty", in: ["특정 개수"] } },
      { key: "display", label: "쿠폰 전시 여부", type: "radio", options: ["전시함", "전시안함"], default: "전시함", help: "메시지 전용·시크릿 쿠폰이면 '전시안함'." },
    ] },
  ],
  checklist: ["쿠폰명·쿠폰 종류 확인", "할인 단위/값 확인", "발급 대상·채널 친구 여부 확인", "적용 대상 확인", "발급기간·유효기간의 시작·종료 '시각' 확인", "발급 수량·전시 여부 확인"],
};

export const COUPON_CHANNELS: CouponChannel[] = [OFFICIAL, NAVER, TALK];

// ───────────────────────── 조건 평가 ─────────────────────────
function evalCond(c: CouponCond, answers: Answers): boolean {
  if ("all" in c) return c.all.every((x) => evalCond(x, answers));
  if ("any" in c) return c.any.some((x) => evalCond(x, answers));
  const v = answers[c.key];
  if (Array.isArray(v)) return v.some((x) => c.in.includes(x));
  return typeof v === "string" && c.in.includes(v);
}
export function isFieldShown(f: CouponField, answers: Answers): boolean {
  return !f.showIf || evalCond(f.showIf, answers);
}
export function isFieldRequired(f: CouponField, answers: Answers): boolean {
  if (f.required) return true;
  return !!f.requiredIf && evalCond(f.requiredIf, answers);
}

export function isDateRange(v: AnswerVal | undefined): v is DateRange {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// "2025-03-05T09:00" → "2025-03-05 09:00"
function fmtDt(s: string): string {
  return s ? s.replace("T", " ") : "";
}
function serializeRange(r: DateRange): string {
  const a = fmtDt(r.start), b = fmtDt(r.end);
  if (a && b) return `${a} ~ ${b}`;
  return a || b || "";
}

function fieldValueStr(f: CouponField, answers: Answers): string {
  const v = answers[f.key];
  if (f.type === "datetime-range") return isDateRange(v) ? serializeRange(v) : "";
  if (Array.isArray(v)) return v.join(", ");
  return (typeof v === "string" ? v : "").trim();
}

function lineFor(f: CouponField, answers: Answers): string | null {
  let val = fieldValueStr(f, answers);
  if (!val) {
    if (f.emptyText) val = f.emptyText;
    else return null;
  }
  const suffix = f.suffix && f.type !== "datetime-range" ? f.suffix : "";
  return `· ${f.label} : ${val}${suffix}`;
}

// 답변을 스캔해 MD가 반드시 봐야 할 위험 항목을 자동 생성.
function buildRisks(ch: CouponChannel, answers: Answers): string[] {
  const risks: string[] = [];
  const s = (k: string): string => (typeof answers[k] === "string" ? (answers[k] as string).trim() : "");

  const pct = ["할인율", "적립율"].includes(s("benefit")) || s("discountUnit") === "할인율(%)" || s("shipFeeType") === "할인율 지정";
  if (pct) {
    const md = s("maxDiscount");
    if (md === "" || md === "0") risks.push("[무제한] 최대 할인금액이 설정되지 않았습니다 — 할인율에 상한이 없으면 결제금액 전액이 할인될 수 있어요. 의도된 설정인지 확인.");
  }
  if (s("dlRedup") === "가능") risks.push("[재발급] 동일인 재발급 '가능' — 1인이 여러 번 수령해 예산이 초과될 수 있어요.");
  if (s("minAmountType") === "제한없음") risks.push("[무제한] 사용 기준 금액 '제한없음' — 소액 주문에도 쿠폰이 적용됩니다.");
  if (s("issueLimit") === "제한 없음") risks.push("[무제한] 발급 건수 '제한 없음' — 발급량이 제한되지 않습니다.");
  if (s("issueQty") === "무제한") risks.push("[무제한] 발급 수량 '무제한' — 발급량이 제한되지 않습니다.");

  for (const f of ch.steps.flatMap((st) => st.fields)) {
    if (f.type !== "datetime-range" || !isFieldShown(f, answers)) continue;
    const v = answers[f.key];
    if (isDateRange(v) && v.start && v.end && v.start >= v.end) risks.push(`[기간오류] ${f.label}: 종료가 시작보다 빠르거나 같습니다.`);
  }
  return risks;
}

// 기본 체크리스트 + 답변 기반 조건부 항목(무관한 항목은 넣지 않아 MD가 둔감해지지 않게).
function buildChecklist(ch: CouponChannel, answers: Answers): string[] {
  const items = [...ch.checklist];
  const s = (k: string): string => (typeof answers[k] === "string" ? (answers[k] as string) : "");
  if (s("issue") === "고객 다운로드 발급") items.push("(다운로드 발급) 상품 상세페이지 노출 여부 재확인");
  if (s("exposeTime") === "지정 기간에만 노출") items.push("(노출) 지정 노출기간 시작·종료 시각 확인");
  const pct = ["할인율", "적립율"].includes(s("benefit")) || s("discountUnit") === "할인율(%)";
  if (pct) items.push("(할인율) 최대 할인금액 상한 재확인");
  return items;
}

// 요청서 텍스트 생성 — Flow 태스크에 붙여넣을 형태(핵심 요약·상세 설정·위험 확인·체크리스트).
export function buildRequestText(ch: CouponChannel, answers: Answers, meta: { requester?: string; date: string }): string {
  const shown = ch.steps.flatMap((st) => st.fields).filter((f) => isFieldShown(f, answers));
  const out: string[] = [];

  out.push(`[쿠폰 등록 요청서 · ${ch.label}]`);
  out.push(`요청자: ${meta.requester || "________"}  ·  요청일: ${meta.date}`);

  const core = shown.filter((f) => f.critical).map((f) => lineFor(f, answers)).filter((x): x is string => !!x);
  if (core.length) out.push("", "■ 핵심 요약 (먼저 확인)", ...core);

  const detail = shown.filter((f) => !f.critical).map((f) => lineFor(f, answers)).filter((x): x is string => !!x);
  if (detail.length) out.push("", "■ 상세 설정", ...detail);

  const risks = buildRisks(ch, answers);
  if (risks.length) out.push("", "⚠️ 위험 확인 (MD 필독)", ...risks.map((r) => `· ${r}`));

  out.push("", "── MD 등록 체크리스트 ──", ...buildChecklist(ch, answers).map((c) => `□ ${c}`));
  return out.join("\n");
}
