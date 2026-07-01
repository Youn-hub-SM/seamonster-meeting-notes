// 쿠폰 등록 요청서 — 채널별 단계별 설문 정의 + 요청서 텍스트 빌더.
//  목적: MD가 쿠폰 등록 시 요청이 제각각이라 실수가 잦음 → 요청자가 단계별로 선택하면
//  일관된 요청서 텍스트가 나오고, MD는 이를 체크리스트 삼아 설정한다(휴먼리스크↓).
//  DB 없음(텍스트만 생성해 복사 → Flow 태스크로 붙여넣기).
//  구조 재설계(2026-07): 조건부 노출 AND/OR, 달력+시간(datetime-range)/발급일기준(int-days) 필드,
//  요청서 3블록(핵심 요약·상세 설정·위험 확인) + 조건부 체크리스트.

// ── 조건부 노출/필수: 단일 + AND(all) + OR(any) + NOT(not) 재귀 ──
export type CouponCond =
  | { key: string; in: string[] }   // 단일: answers[key]가 in 중 하나(체크박스는 교집합)
  | { all: CouponCond[] }           // AND
  | { any: CouponCond[] }           // OR
  | { not: CouponCond };            // NOT

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
  // 다른 선택에 따라 특정 옵션을 '선택 불가(비활성)'로 — when이 참이면 options의 각 값을 잠그고 reason 안내.
  optionsDisabledIf?: { options: string[]; when: CouponCond; reason: string }[];
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
        showIf: { key: "benefit", in: ["할인율", "적립율"] },
        requiredIf: { key: "benefit", in: ["할인율", "적립율"] },
        help: "⚠️ 할인율/적립율은 상한을 반드시 지정하세요. 0원 = 제한 없이 전액 적용(사고 위험)." },
      { key: "shipFeeType", label: "배송비 할인 방식", type: "radio", options: ["전액 무료(무료배송)", "할인금액 지정"], default: "전액 무료(무료배송)", showIf: { key: "benefit", in: ["기본 배송비 할인"] }, requiredIf: { key: "benefit", in: ["기본 배송비 할인"] }, help: "배송비 쿠폰은 금액(원) 또는 무료배송만 됩니다 — 할인율(%)은 지원하지 않습니다." },
      { key: "shipFeeValue", label: "배송비 할인 금액", type: "number", suffix: "원", placeholder: "예: 2500", showIf: { key: "shipFeeType", in: ["할인금액 지정"] }, requiredIf: { key: "shipFeeType", in: ["할인금액 지정"] } },
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
//  ★타겟팅 대상이 혜택종류·발급방법을 자동 결정한다(가이드 기준). 포인트는 재구매·등급고객만·% 전용.
//  발급방법은 필드로 묻지 않고 대상에서 파생(deriveIssueMethod) — 그룹만 예외로 택1.
const NAVER: CouponChannel = {
  key: "naver",
  label: "네이버",
  intro: "네이버 스마트스토어 혜택(쿠폰/포인트). 대상을 고르면 가능한 항목만 순서대로 나타납니다.",
  steps: [
    { title: "혜택 이름", fields: [
      { key: "name", label: "혜택 이름", type: "text", required: true, critical: true, placeholder: "예: 블랙프라이데이 10% 할인쿠폰 / 10월 재구매고객 할인쿠폰", help: "⚠️ 최대 30자(모바일 15자 이후 말줄임). 권장 = 행사목적 + 타겟 + 쿠폰종류. 할인율·스토어명은 자동 노출되니 이름에 안 넣어도 됩니다." },
    ] },
    { title: "타겟팅 대상", desc: "누구에게 제공하나요? (대상이 혜택종류·발급방법을 결정)", fields: [
      { key: "target", label: "타겟팅 대상", type: "radio", required: true, critical: true, options: ["전체 고객", "첫구매 고객", "재구매 고객", "알림받기", "타겟팅-고객지정", "타겟팅-그룹", "등급 고객"], default: "전체 고객", help: "대상이 혜택 종류와 발급 방법을 자동으로 결정합니다. 포인트는 재구매·등급 고객만 가능." },
      { key: "custType", label: "고객 유형 제한", type: "radio", options: ["제한없음", "네이버플러스 멤버십"], default: "제한없음", showIf: { key: "target", in: ["전체 고객"] } },
      { key: "rebuyCond", label: "재구매 조건", type: "radio", options: ["스토어 구매(내스토어 전체)", "상품 구매(지정 상품)"], default: "스토어 구매(내스토어 전체)", showIf: { key: "target", in: ["재구매 고객"] }, requiredIf: { key: "target", in: ["재구매 고객"] }, help: "최근 180일 구매확정 이력 대상. '스토어 구매'면 혜택상품이 자동으로 내스토어 전체가 됩니다." },
      { key: "custIds", label: "대상 고객 ID", type: "textarea", placeholder: "고객 ID를 줄바꿈으로 (최대 100명)", showIf: { key: "target", in: ["타겟팅-고객지정"] }, requiredIf: { key: "target", in: ["타겟팅-고객지정"] }, help: "⚠️ 최대 100명, 구매이력 또는 알림받기 동의 고객만. 즉시발급이라 발급 후 회수 불가." },
      { key: "targetGroup", label: "타겟팅 그룹 조건", type: "textarea", placeholder: "거래기간 / 거래정보(주문금액·구매빈도) / 관심여부(알림받기·상품찜) / 예상 고객수", showIf: { key: "target", in: ["타겟팅-그룹"] }, requiredIf: { key: "target", in: ["타겟팅-그룹"] } },
      { key: "groupIssueMethod", label: "발급 방법(그룹)", type: "radio", critical: true, options: ["다운로드", "즉시발급"], default: "다운로드", showIf: { key: "target", in: ["타겟팅-그룹"] }, requiredIf: { key: "target", in: ["타겟팅-그룹"] }, help: "타겟팅-그룹만 발급 방법을 선택합니다. 다른 대상은 자동 결정됩니다." },
      { key: "gradeName", label: "대상 등급", type: "text", placeholder: "예: VIP, 골드", showIf: { key: "target", in: ["등급 고객"] }, requiredIf: { key: "target", in: ["등급 고객"] } },
    ] },
    { title: "혜택 종류", desc: "쿠폰인가요, 포인트인가요?", fields: [
      { key: "benefitKind", label: "혜택 종류", type: "radio", required: true, critical: true, options: ["쿠폰", "포인트"], default: "쿠폰", help: "포인트는 재구매·등급 고객만 선택할 수 있습니다.",
        optionsDisabledIf: [{ options: ["포인트"], when: { not: { key: "target", in: ["재구매 고객", "등급 고객"] } }, reason: "포인트는 재구매·등급 고객만 가능" }] },
      { key: "pointRate", label: "적립율", type: "number", suffix: "%", critical: true, showIf: { all: [{ key: "benefitKind", in: ["포인트"] }, { key: "target", in: ["재구매 고객", "등급 고객"] }] }, requiredIf: { all: [{ key: "benefitKind", in: ["포인트"] }, { key: "target", in: ["재구매 고객", "등급 고객"] }] }, help: "⚠️ 판매가의 15% 이하·최대 20만원. 원 단위 입력 불가(정책). 구매확정 시 지급(옵션가 포함, 배송비·추가구성·쿠폰할인 제외)." },
      { key: "couponKind", label: "쿠폰 종류", type: "radio", critical: true, options: ["상품중복할인", "스토어장바구니할인", "배송비할인"], default: "상품중복할인", showIf: { key: "benefitKind", in: ["쿠폰"] }, requiredIf: { key: "benefitKind", in: ["쿠폰"] }, help: "상품중복할인=옵션 1개당 1장(정률 최대 70%). 스토어장바구니=총결제금액 1장(혜택상품 '내스토어 전체'만). 배송비=배송비 1장(최소주문금액 판매가 기준)." },
      { key: "issueLimit", label: "발급 건수", type: "radio", options: ["제한 없음(1인 1회)", "제한 있음(선착순)"], default: "제한 없음(1인 1회)", showIf: { key: "benefitKind", in: ["쿠폰"] } },
      { key: "issueLimitN", label: "선착순 발급 건수", type: "number", suffix: "건", showIf: { key: "issueLimit", in: ["제한 있음(선착순)"] }, requiredIf: { key: "issueLimit", in: ["제한 있음(선착순)"] } },
      { key: "discountUnit", label: "할인 설정", type: "radio", critical: true, options: ["정률할인(%)", "정액할인(원)"], default: "정률할인(%)", showIf: { key: "benefitKind", in: ["쿠폰"] }, requiredIf: { key: "benefitKind", in: ["쿠폰"] }, help: "단위를 먼저 고르면 아래 입력칸이 바뀝니다." },
      { key: "discountPct", label: "할인율", type: "number", suffix: "%", critical: true, showIf: { key: "discountUnit", in: ["정률할인(%)"] }, requiredIf: { key: "discountUnit", in: ["정률할인(%)"] }, help: "상품중복할인은 정률 최대 70%. 스토어장바구니는 최소주문금액의 70%까지." },
      { key: "discountAmt", label: "할인액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["정액할인(원)"] }, requiredIf: { key: "discountUnit", in: ["정액할인(원)"] } },
      { key: "maxDiscount", label: "최대 할인금액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["정률할인(%)"] }, requiredIf: { key: "discountUnit", in: ["정률할인(%)"] }, help: "⚠️ 상한 999,990원. (최소주문금액×할인율) ≤ 최대할인금액이어야 발급됩니다. 예: 최소 5만원·10% → 5,000원 이상 입력." },
      { key: "minAmount", label: "최소주문금액", type: "number", suffix: "원 이상", emptyText: "제한없음", showIf: { key: "benefitKind", in: ["쿠폰"] }, help: "산정 기준이 쿠폰마다 다릅니다. 배송비할인=판매가 기준, 상품중복할인=(판매가+옵션가)×수량−즉시/상품할인, 스토어장바구니=총결제금액(배송비 제외)." },
    ] },
    { title: "기간", desc: "언제 발급하고 언제까지 유효한가요?", fields: [
      { key: "issuePeriod", label: "혜택 발급기간", type: "datetime-range", required: true, critical: true, help: "다운로드형=이 기간 동안 다운로드 노출 / 즉시발급형=이 날 즉시 지급. 첫구매·재구매·타겟팅그룹은 익일부터 적용." },
      { key: "validType", label: "쿠폰 유효기간", type: "radio", critical: true, options: ["기간으로 설정", "발급일 기준"], default: "발급일 기준", showIf: { key: "benefitKind", in: ["쿠폰"] }, requiredIf: { key: "benefitKind", in: ["쿠폰"] }, help: "포인트는 유효기간 개념이 없습니다." },
      { key: "validRange", label: "유효기간", type: "datetime-range", critical: true, showIf: { key: "validType", in: ["기간으로 설정"] }, requiredIf: { key: "validType", in: ["기간으로 설정"] }, help: "⚠️ 유효 시작 ≥ 발급기간 시작, 유효 종료 ≥ 발급기간 종료." },
      { key: "validDays", label: "발급일로부터", type: "int-days", suffix: "일", presets: [7, 14, 30], default: "14", showIf: { key: "validType", in: ["발급일 기준"] }, requiredIf: { key: "validType", in: ["발급일 기준"] } },
    ] },
    { title: "혜택 상품 지정", desc: "어디에 적용할까요?", fields: [
      { key: "applyProduct", label: "혜택 상품 지정", type: "radio", required: true, critical: true, options: ["내스토어 상품 전체", "카테고리 선택", "상품 선택"], default: "내스토어 상품 전체", help: "상품 선택은 최대 500개·'전시중' 상품만. 대상·쿠폰 종류에 따라 일부 선택지가 잠깁니다.",
        optionsDisabledIf: [
          { options: ["카테고리 선택"], when: { not: { key: "target", in: ["알림받기", "타겟팅-고객지정"] } }, reason: "카테고리 선택은 알림받기·타겟팅-고객지정 대상만 가능" },
          { options: ["카테고리 선택", "상품 선택"], when: { key: "couponKind", in: ["스토어장바구니할인"] }, reason: "스토어장바구니할인은 '내스토어 상품 전체'만 가능" },
          { options: ["카테고리 선택", "상품 선택"], when: { key: "rebuyCond", in: ["스토어 구매(내스토어 전체)"] }, reason: "재구매 '스토어 구매'는 내스토어 전체로 고정" },
        ] },
      { key: "productNames", label: "카테고리/상품명", type: "textarea", placeholder: "카테고리명 또는 상품명을 줄바꿈으로 (상품 선택 최대 500개)", showIf: { key: "applyProduct", in: ["카테고리 선택", "상품 선택"] }, requiredIf: { key: "applyProduct", in: ["카테고리 선택", "상품 선택"] } },
    ] },
  ],
  checklist: ["혜택 이름 30자 이내(모바일 15자) 확인", "타겟팅 대상 확인 — 혜택종류·발급방법이 대상에서 자동 결정됨", "혜택 종류(쿠폰/포인트)와 값 확인", "발급기간·유효기간의 시작·종료 '시각' 확인", "혜택 상품 지정 확인"],
};

// ───────────────────────── 톡스토어(카카오) ─────────────────────────
//  가이드: 유효기간은 '발급일 N일' 단일 방식. 정률/정액 표기. 첫구매·장바구니는 적용대상 제약(위험감지).
//  판매자포인트(구매·리뷰)는 '상품 정보'에서 설정하는 항목이라 쿠폰 요청서엔 없음.
const TALK: CouponChannel = {
  key: "talk",
  label: "톡스토어",
  intro: "카카오 톡스토어 쿠폰. 순서대로 고르면 요청서가 만들어집니다.",
  steps: [
    { title: "쿠폰명", note: "동일 기간 내 최대 20개까지만 발행할 수 있어요. 현재 발행 편수는 판매자센터에서 직접 확인하세요.", fields: [
      { key: "name", label: "쿠폰명", type: "text", required: true, critical: true, placeholder: "예: [톡친구] 10% (2507)", help: "월/차수·타겟을 넣으면 목록에서 구분이 쉽고 중복발행을 막습니다." },
    ] },
    { title: "혜택", desc: "어떤 쿠폰을, 얼마나 할인할까요?", fields: [
      { key: "couponKind", label: "쿠폰 종류", type: "radio", required: true, critical: true, options: ["상품 할인쿠폰", "장바구니 할인쿠폰"], default: "상품 할인쿠폰", help: "상품=주문번호 단위(주문번호당 1개, 즉시할인·톡딜과 동시 적용). 장바구니=스토어 단위(스토어당 1개). ⚠️ 장바구니는 적용 대상이 '스토어 전체 상품'만 가능합니다." },
      { key: "discountUnit", label: "할인 단위", type: "radio", required: true, options: ["정률(%)", "정액(원)"], help: "카카오 표기 그대로 정률/정액. 단위를 먼저 고르면 아래 입력칸이 바뀝니다." },
      { key: "discountPct", label: "할인율", type: "number", suffix: "%", critical: true, showIf: { key: "discountUnit", in: ["정률(%)"] }, requiredIf: { key: "discountUnit", in: ["정률(%)"] }, help: "1~99%, 1% 단위. 계산액이 최대 할인금액을 넘으면 최대금액까지만 할인됩니다." },
      { key: "discountAmt", label: "할인액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["정액(원)"] }, requiredIf: { key: "discountUnit", in: ["정액(원)"] }, help: "10원 단위로 입력하세요." },
      { key: "maxDiscount", label: "최대 할인금액", type: "number", suffix: "원", critical: true, showIf: { key: "discountUnit", in: ["정률(%)"] }, requiredIf: { key: "discountUnit", in: ["정률(%)"] }, help: "⚠️ 정률이면 필수. 정률 계산액이 이 금액을 넘으면 이 금액까지만 할인. 장바구니 정률은 상품 할인쿠폰 적용 후 금액 기준으로 계산됩니다." },
      { key: "minAmount", label: "최소 주문금액", type: "number", suffix: "원 이상", emptyText: "제한없음", help: "이 금액 이상일 때만 사용 가능. 기준 = (판매가−즉시할인−소문내기할인−톡딜할인+옵션가) × 주문수량. 비우면 제한 없음." },
    ] },
    { title: "발급 대상", desc: "누구에게 제공하나요?", fields: [
      { key: "target", label: "쿠폰 발급 대상", type: "radio", required: true, critical: true, options: ["전체 고객", "첫구매 고객", "재구매 고객"], default: "전체 고객", help: "첫구매=1년 이내 구매이력 없음, 재구매=1년 이내 구매이력 있음. ⚠️ 첫구매 고객 쿠폰은 적용 대상을 '스토어 전체 상품' 또는 '카테고리 선택'으로만 설정할 수 있습니다(상품·기획전 불가)." },
      { key: "friend", label: "채널 친구 여부", type: "radio", options: ["설정안함", "설정함(톡채널 친구)"], default: "설정함(톡채널 친구)", help: "'설정함'이면 다운로드 시 친구추가 팝업이 뜨고, 친구만 다운로드·사용할 수 있습니다(친구 유입 유도용)." },
    ] },
    { title: "적용", desc: "어디에 적용할까요?", fields: [
      { key: "applyTarget", label: "쿠폰 적용 대상", type: "radio", required: true, options: ["스토어 전체 상품", "카테고리 선택", "상품 선택", "기획전 선택"], default: "스토어 전체 상품", help: "카테고리 최대 10개 / 상품 최대 30개('판매중'만) / 기획전 최대 5개('전시중'만). 대상·쿠폰 종류에 따라 일부 선택지가 잠깁니다.",
        optionsDisabledIf: [
          { options: ["상품 선택", "기획전 선택"], when: { key: "target", in: ["첫구매 고객"] }, reason: "첫구매 고객은 전체상품·카테고리만 가능" },
          { options: ["카테고리 선택", "상품 선택", "기획전 선택"], when: { key: "couponKind", in: ["장바구니 할인쿠폰"] }, reason: "장바구니 할인쿠폰은 '스토어 전체 상품'만 가능" },
        ] },
      { key: "productNames", label: "카테고리/상품/기획전명", type: "textarea", placeholder: "이름을 줄바꿈으로 입력", showIf: { key: "applyTarget", in: ["카테고리 선택", "상품 선택", "기획전 선택"] }, requiredIf: { key: "applyTarget", in: ["카테고리 선택", "상품 선택", "기획전 선택"] }, help: "이름을 줄바꿈으로 입력. 개수 상한(카테고리10·상품30·기획전5)을 넘지 마세요." },
    ] },
    { title: "기간·발급·전시", desc: "언제 발급하고, 언제까지 쓰나요?", fields: [
      { key: "issuePeriod", label: "쿠폰 발급 기간", type: "datetime-range", required: true, critical: true, help: "발행중 상태에서만 고객이 다운로드할 수 있어요." },
      { key: "validDays", label: "발급일로부터", type: "int-days", suffix: "일", presets: [7, 14, 30], default: "7", required: true, critical: true, help: "다운로드 시점부터 N일. 발급 당일은 포함하지 않고 종료일 23:59:59에 만료됩니다(예: 12/1 발급·7일 → 12/8 23:59:59)." },
      { key: "issueQty", label: "발급 수량", type: "radio", required: true, options: ["특정 개수", "무제한"], default: "무제한", help: "카카오 계정당 최대 1회 다운로드. '특정 개수'면 소진 시 자동으로 '소진중지'됩니다." },
      { key: "issueQtyN", label: "발급 개수", type: "number", suffix: "개", showIf: { key: "issueQty", in: ["특정 개수"] }, requiredIf: { key: "issueQty", in: ["특정 개수"] } },
      { key: "display", label: "쿠폰 전시 여부", type: "radio", options: ["전시함", "전시안함"], default: "전시함", help: "전시함=스토어홈·상품상세 노출. 전시안함=마케팅 메시지를 받은 고객만 발급받을 수 있는 시크릿 쿠폰입니다." },
    ] },
  ],
  checklist: ["쿠폰명·쿠폰 종류 확인", "할인 단위/값 확인", "발급 대상·채널 친구 여부 확인", "적용 대상 확인", "발급기간·유효기간 확인", "발급 수량·전시 여부 확인"],
};

export const COUPON_CHANNELS: CouponChannel[] = [OFFICIAL, NAVER, TALK];

// ───────────────────────── 조건 평가 (ancestor-aware) ─────────────────────────
//  핵심: 숨겨진 필드도 answers[key]는 남는다 → showIf가 그 잔존값으로 자식을 계속 노출시키는 결함.
//  해결: showIf가 참조하는 key가 '필드'이고 그 필드 자체가 숨겨졌으면 그 조건항을 false로 본다.
//        → 부모를 숨기면 (잔존값과 무관하게) 자식 subtree 전체가 자동으로 사라진다.
const _fieldIndexCache = new WeakMap<CouponChannel, Map<string, CouponField>>();
function fieldIndex(ch: CouponChannel): Map<string, CouponField> {
  let m = _fieldIndexCache.get(ch);
  if (!m) { m = new Map(); for (const st of ch.steps) for (const f of st.fields) m.set(f.key, f); _fieldIndexCache.set(ch, m); }
  return m;
}
function evalCond(c: CouponCond, answers: Answers, ch: CouponChannel, seen: Set<string>): boolean {
  if ("all" in c) return c.all.every((x) => evalCond(x, answers, ch, seen));
  if ("any" in c) return c.any.some((x) => evalCond(x, answers, ch, seen));
  if ("not" in c) return !evalCond(c.not, answers, ch, seen);
  const parent = fieldIndex(ch).get(c.key);
  if (parent && !isFieldShownInner(parent, answers, ch, seen)) return false;   // 부모 숨김 전파
  const v = answers[c.key];
  if (Array.isArray(v)) return v.some((x) => c.in.includes(x));
  return typeof v === "string" && c.in.includes(v);
}
function isFieldShownInner(f: CouponField, answers: Answers, ch: CouponChannel, seen: Set<string>): boolean {
  if (!f.showIf) return true;
  if (seen.has(f.key)) return false;             // 순환: 안전측 숨김
  const next = new Set(seen); next.add(f.key);   // 형제 분기 오염 방지: 사본
  return evalCond(f.showIf, answers, ch, next);
}
export function isFieldShown(f: CouponField, answers: Answers, ch: CouponChannel): boolean {
  return isFieldShownInner(f, answers, ch, new Set());
}
export function isFieldRequired(f: CouponField, answers: Answers, ch: CouponChannel): boolean {
  if (!isFieldShown(f, answers, ch)) return false;         // 숨은 필드는 필수 아님(불변식)
  if (f.required) return true;
  return !!f.requiredIf && evalCond(f.requiredIf, answers, ch, new Set([f.key]));
}
// 필드가 실제 노출된 경우에만 문자열 값 반환(숨은 필드는 "") — 위험/체크리스트의 2차 잔존값 누수 차단.
function shownStr(ch: CouponChannel, answers: Answers, k: string): string {
  const f = fieldIndex(ch).get(k);
  if (f && !isFieldShown(f, answers, ch)) return "";
  const v = answers[k];
  return typeof v === "string" ? v.trim() : "";
}
const numOf = (v: string): number => Number(v.replace(/[^\d.]/g, "")) || 0;

// 다른 선택 때문에 '선택 불가'가 된 옵션 → { 옵션값: 사유 } 맵. 라디오/체크박스 렌더에서 비활성 처리.
export function disabledOptions(f: CouponField, answers: Answers, ch: CouponChannel): Record<string, string> {
  const out: Record<string, string> = {};
  if (!f.optionsDisabledIf) return out;
  for (const rule of f.optionsDisabledIf) {
    if (evalCond(rule.when, answers, ch, new Set())) for (const o of rule.options) if (!out[o]) out[o] = rule.reason;
  }
  return out;
}

// 선택돼 있던 값이 '선택 불가'가 되면(예: 대상을 바꿔 포인트가 잠김) 기본값/첫 유효옵션으로 자동 교정.
//  값이 바뀔 때마다 호출해 잠긴 값이 남지 않게 한다(수렴할 때까지 최대 몇 회 반복).
export function healAnswers(ch: CouponChannel, a: Answers): Answers {
  let cur = a, changed = false;
  for (let i = 0; i < 8; i++) {
    let hit = false;
    const next: Answers = { ...cur };
    for (const st of ch.steps) for (const f of st.fields) {
      if (f.type !== "radio" || !f.optionsDisabledIf) continue;
      const dis = disabledOptions(f, next, ch);
      const v = next[f.key];
      if (typeof v === "string" && dis[v]) {
        const def = typeof f.default === "string" ? f.default : "";
        next[f.key] = def && !dis[def] ? def : ((f.options || []).find((o) => !dis[o]) || "");
        hit = true;
      }
    }
    if (!hit) break;
    cur = next; changed = true;
  }
  return changed ? cur : a;
}

export function isDateRange(v: AnswerVal | undefined): v is DateRange {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// 네이버: 타겟팅 대상이 발급 방법·적용일을 자동 결정(필드로 묻지 않고 파생).
function deriveIssueMethod(answers: Answers): string {
  const t = typeof answers["target"] === "string" ? (answers["target"] as string) : "";
  switch (t) {
    case "전체 고객": case "첫구매 고객": case "알림받기": return "다운로드";
    case "재구매 고객": case "타겟팅-고객지정": case "등급 고객": return "즉시발급";
    case "타겟팅-그룹": return (typeof answers["groupIssueMethod"] === "string" && answers["groupIssueMethod"]) ? (answers["groupIssueMethod"] as string) : "다운로드";
    default: return "";
  }
}
function deriveApplyDay(answers: Answers): string {
  const t = typeof answers["target"] === "string" ? (answers["target"] as string) : "";
  return ["전체 고객", "알림받기", "타겟팅-고객지정"].includes(t) ? "혜택 적용일 당일 설정 가능" : "혜택 적용일 익일부터 (당일 불가)";
}

// KST 오늘(YYYY-MM-DD).
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

// 채널별 '노출/발급 시작 시점' 파생 — 조기 노출 방지 배너·위험·체크리스트의 공용 소스.
//  when=사람이 읽는 문자열, kind=문구 분기(immediate=등록 즉시 노출, scheduled=예정, conditional=조건/주기, none=미입력).
//  range의 start는 shownStr로 못 읽음(문자열만 반환) → answers 직접 + isDateRange. radio(issue/exposeTime)만 shownStr.
export type ExposeKind = "immediate" | "scheduled" | "conditional" | "none";
export function deriveExposeStart(ch: CouponChannel, answers: Answers): { when: string; kind: ExposeKind } {
  const s = (k: string): string => shownStr(ch, answers, k);
  const startOf = (k: string): string => {
    const v = answers[k];
    return isDateRange(v) && v.start ? fmtDt(v.start) : "";
  };
  const past = (start: string): boolean => start.slice(0, 10) <= todayKst();   // 오늘 이하면 등록 즉시 노출

  if (ch.key === "official") {
    const issue = s("issue");
    if (issue === "조건부 자동 발급") return { when: "해당 없음 (조건 충족 시 자동 발급 — 고정 노출일 없음)", kind: "conditional" };
    if (issue === "정기 자동 발급") return { when: "해당 없음 (설정 주기마다 자동 발급 — 고정 노출일 없음)", kind: "conditional" };
    if (s("exposeTime") === "지정 기간에만 노출") {
      const start = startOf("exposePeriod");
      if (!start) return { when: "⚠️ 노출 시작 일시 미입력 — 반드시 채우세요", kind: "none" };
      return { when: `${start} 부터`, kind: past(start) ? "immediate" : "scheduled" };
    }
    return { when: "등록 즉시 (즉시 노출 설정)", kind: "immediate" };
  }
  if (ch.key === "naver") {
    const start = startOf("issuePeriod");
    if (!start) return { when: "⚠️ 발급기간 시작 미입력 — 반드시 채우세요", kind: "none" };
    const nextDay = ["첫구매 고객", "재구매 고객", "타겟팅-그룹"].includes(s("target"));
    if (deriveIssueMethod(answers) === "즉시발급") {
      return { when: `${start} (발급일 즉시 지급 · 회수 불가)${nextDay ? " (단 이 대상은 익일부터 적용)" : ""}`, kind: past(start) ? "immediate" : "scheduled" };
    }
    return { when: `${start} 부터 다운로드 노출`, kind: past(start) ? "immediate" : "scheduled" };
  }
  if (ch.key === "talk") {
    const start = startOf("issuePeriod");
    if (!start) return { when: "⚠️ 발급기간 시작 미입력 — 반드시 채우세요", kind: "none" };
    return { when: `${start} 부터 (발행중 상태에서만 다운로드)`, kind: past(start) ? "immediate" : "scheduled" };
  }
  return { when: "", kind: "none" };
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
  const val = fieldValueStr(f, answers);
  if (!val) return f.emptyText ? `· ${f.label} : ${f.emptyText}` : null;   // emptyText엔 단위(원 이상 등) 안 붙임
  const suffix = f.suffix && f.type !== "datetime-range" ? f.suffix : "";
  return `· ${f.label} : ${val}${suffix}`;
}

// 답변을 스캔해 MD가 반드시 봐야 할 위험 항목을 자동 생성. s()는 '노출된' 필드값만 읽어 잔존값 오탐 방지.
function buildRisks(ch: CouponChannel, answers: Answers): string[] {
  const risks: string[] = [];
  const s = (k: string): string => shownStr(ch, answers, k);
  const today = todayKst();
  const startDate = (k: string): string => { const v = answers[k]; return isDateRange(v) && v.start ? v.start.slice(0, 10) : ""; };

  const pct = ["할인율", "적립율"].includes(s("benefit")) || s("discountUnit") === "할인율(%)";
  if (pct) {
    const md = s("maxDiscount");
    if (md === "" || md === "0") risks.push("[무제한] 최대 할인금액이 설정되지 않았습니다 — 할인율에 상한이 없으면 결제금액 전액이 할인될 수 있어요. 의도된 설정인지 확인.");
  }
  if (s("dlRedup") === "가능") risks.push("[재발급] 동일인 재발급 '가능' — 1인이 여러 번 수령해 예산이 초과될 수 있어요.");
  if (s("minAmountType") === "제한없음") risks.push("[무제한] 사용 기준 금액 '제한없음' — 소액 주문에도 쿠폰이 적용됩니다.");
  if (s("issueLimit") === "제한 없음") risks.push("[무제한] 발급 건수 '제한 없음' — 발급량이 제한되지 않습니다.");
  if (s("issueQty") === "무제한") risks.push("[무제한] 발급 수량 '무제한' — 발급량이 제한되지 않습니다.");

  // ── 공식몰 조기/즉시 노출 위험 ──
  if (ch.key === "official") {
    const issue = s("issue"), et = s("exposeTime");
    if (et === "즉시 노출" && ["대상자 지정 발급", "고객 다운로드 발급"].includes(issue)) risks.unshift("[즉시노출] 노출 시점이 '즉시 노출' — 지금 등록하면 바로 고객 화면에 노출/다운로드됩니다. 노출 예정일이 있다면 '지정 기간에만 노출'로 바꾸고 노출 시작 시각을 예정일로 설정하세요.");
    if (et === "지정 기간에만 노출") {
      const st = startDate("exposePeriod");
      if (st && st <= today) risks.unshift("[조기노출] 지정 노출 시작일이 오늘 이하입니다 — 지금 등록하면 예정보다 일찍 노출됩니다. 노출 시작 시각을 예정일로 맞추세요.");
    }
  }

  // ── 네이버 특화 위험(가이드 기반) ──
  if (ch.key === "naver") {
    const t = s("target"), bk = s("benefitKind"), ck = s("couponKind"), du = s("discountUnit"), ap = s("applyProduct");
    const nm = typeof answers["name"] === "string" ? (answers["name"] as string) : "";
    if (nm.length > 30) risks.push(`[이름초과] 혜택 이름이 30자를 넘습니다(${nm.length}자) — 등록 시 잘립니다(모바일 15자 이후 말줄임).`);
    if (bk === "포인트" && !["재구매 고객", "등급 고객"].includes(t)) risks.push("[대상오류] 포인트는 재구매·등급 고객만 가능 — 현재 대상에서는 발급되지 않습니다.");
    const pr = numOf(s("pointRate"));
    if (bk === "포인트" && pr > 15) risks.push(`[정책초과] 적립율 ${pr}% — 판매가 15%를 초과하면 등록 불가(최대 20만원 상한도 확인).`);
    if (bk === "쿠폰" && du === "정률할인(%)") {
      const p = numOf(s("discountPct")), minA = numOf(s("minAmount")), maxD = numOf(s("maxDiscount"));
      if (maxD === 0) risks.push("[무제한] 최대 할인금액 미설정 — 정률 상한이 없어 과다할인 위험(상한 999,990원).");
      else if (minA > 0 && p > 0 && (minA * p) / 100 > maxD) risks.push(`[발급불가] 최소주문금액×할인율(${Math.round((minA * p) / 100).toLocaleString()}원) > 최대할인금액(${maxD.toLocaleString()}원) — 이대로면 쿠폰이 발급되지 않습니다. 최대할인금액을 올리세요.`);
      if (ck === "상품중복할인" && p > 70) risks.push(`[정책초과] 상품중복할인 정률은 최대 70% (현재 ${p}%).`);
    }
    const ip = answers["issuePeriod"], vr = answers["validRange"];
    if (bk === "쿠폰" && s("validType") === "기간으로 설정" && isDateRange(ip) && isDateRange(vr)) {
      if (vr.start && ip.start && vr.start < ip.start) risks.push("[기간오류] 유효 시작이 발급기간 시작보다 빠릅니다 (유효 시작 ≥ 발급 시작).");
      if (vr.end && ip.end && vr.end < ip.end) risks.push("[기간오류] 유효 종료가 발급기간 종료보다 빠릅니다 (유효 종료 ≥ 발급 종료).");
    }
    if (ap === "카테고리 선택" && !["알림받기", "타겟팅-고객지정"].includes(t)) risks.push("[제약위반] '카테고리 선택'은 알림받기·타겟팅-고객지정 대상만 가능 — 현재 대상에서는 선택 불가.");
    if (bk === "쿠폰" && ck === "스토어장바구니할인" && ap !== "내스토어 상품 전체") risks.push("[제약위반] 스토어장바구니할인은 혜택상품이 '내스토어 상품 전체'만 가능 — 상품/카테고리 지정 불가.");
    if (deriveIssueMethod(answers) === "즉시발급") risks.push("[회수불가] 즉시발급 쿠폰은 발급 후 회수할 수 없습니다 — 대상·값을 다시 확인.");
    if (["첫구매 고객", "재구매 고객", "타겟팅-그룹"].includes(t) && isDateRange(ip) && ip.start) {
      if (ip.start.slice(0, 10) === today) risks.push("[적용일] 이 대상은 당일 적용 불가(익일부터) — 발급 시작일을 내일 이후로 조정하세요.");
    }
    // ── 조기/즉시 노출('오늘 이하면 등록 즉시 나감' 축 — 위 [적용일] 당일-불가와 별개) ──
    const ipStart = startDate("issuePeriod");
    if (ipStart && ipStart <= today) {
      if (deriveIssueMethod(answers) === "즉시발급") risks.unshift("[즉시지급] 발급일이 오늘 이하 — 지금 등록하면 대상 고객에게 즉시 지급되고 회수 불가입니다. 발급일을 예정일로 맞추세요.");
      else risks.unshift("[조기노출] 발급기간 시작이 오늘 이하 — 지금 등록하면 즉시 다운로드가 열립니다. 시작 시각을 예정일로 맞추세요.");
    }
  }

  // ── 톡스토어 특화 위험(가이드 기반) ── 라벨을 '정률(%)'로 바꿨으므로 정률 위험은 여기서 전담(공용 pct는 '할인율(%)'만 매칭).
  if (ch.key === "talk") {
    const t = s("target"), ck = s("couponKind"), du = s("discountUnit"), at = s("applyTarget");
    if (t === "첫구매 고객" && ["상품 선택", "기획전 선택"].includes(at)) risks.push("[제약위반] 첫구매 고객 쿠폰은 적용 대상을 '스토어 전체 상품' 또는 '카테고리 선택'으로만 설정할 수 있습니다 — 상품·기획전 선택은 발행되지 않습니다.");
    if (ck === "장바구니 할인쿠폰" && at !== "" && at !== "스토어 전체 상품") risks.push("[제약위반] 장바구니 할인쿠폰은 적용 대상이 '스토어 전체 상품'만 가능합니다 — 카테고리·상품·기획전 지정 불가.");
    if (du === "정률(%)") {
      const p = numOf(s("discountPct")), md = s("maxDiscount");
      if (md === "" || md === "0") risks.push("[무제한] 정률 쿠폰인데 최대 할인금액이 없습니다 — 상한이 없으면 결제금액이 과다 할인될 수 있어요(정률은 최대 할인금액 필수).");
      if (p > 0 && (p < 1 || p > 99)) risks.push(`[정책초과] 정률 할인율은 1~99%만 가능합니다 (현재 ${p}%).`);
    }
    // ── 조기 노출 ── 발행 기간 시작이 오늘 이하면 '발행중'=즉시 다운로드.
    const ipStartT = startDate("issuePeriod");
    if (ipStartT && ipStartT <= today) risks.unshift("[조기노출] 발급 기간 시작이 오늘 이하 — 지금 등록해 '발행중'이 되면 바로 다운로드가 열립니다. 예정일 전이라면 발급 시작 시각을 미루거나 '발행대기'로 등록하세요.");
  }

  for (const f of ch.steps.flatMap((st) => st.fields)) {
    if (f.type !== "datetime-range" || !isFieldShown(f, answers, ch)) continue;
    const v = answers[f.key];
    if (isDateRange(v) && v.start && v.end && v.start >= v.end) risks.push(`[기간오류] ${f.label}: 종료가 시작보다 빠르거나 같습니다.`);
  }
  return risks;
}

// 기본 체크리스트 + 답변 기반 조건부 항목(무관한 항목은 넣지 않아 MD가 둔감해지지 않게).
function buildChecklist(ch: CouponChannel, answers: Answers): string[] {
  const items = [...ch.checklist];
  const s = (k: string): string => shownStr(ch, answers, k);
  // ★최우선 안전 항목(항상 선두): 조기 노출 방지 — '사용 기간'이 아니라 '노출 시작' 기준.
  const ex = deriveExposeStart(ch, answers);
  items.unshift(`[조기노출 방지] 노출 시작(${ex.when}) 전까지 '발행대기/미노출' 유지 — 예정일 전 미리 노출·발행 절대 금지`);
  if (ex.kind === "immediate") items.push("[즉시노출 확인] 이 설정은 '등록 즉시 노출/발급' — 지금이 노출 예정 시점이 맞는지 등록 직전 재확인");
  else if (ex.kind === "scheduled") {
    if (ch.key === "official") items.push("(노출) 노출 시점 '지정 기간에만 노출' + 노출기간 시작=예정일인지 확인");
    if (ch.key === "naver") items.push("(발급기간) 시작=예정일로 두고, 시작 전에는 등록하지 말거나 노출 안 되는지 확인");
    if (ch.key === "talk") items.push("(발행) '발행대기'로 등록하고 예정일에 '발행'으로 전환(발행중 전엔 다운로드 불가) 확인");
  } else if (ex.kind === "conditional") items.push("(조건/주기) 고정 노출일 아님 — 원하는 시작일에 맞춰 조건/주기를 활성화(미리 켜면 즉시 발급) 확인");
  if (s("issue") === "고객 다운로드 발급") items.push("(다운로드 발급) 상품 상세페이지 노출 여부 재확인");
  if (s("exposeTime") === "지정 기간에만 노출") items.push("(노출) 지정 노출기간 시작·종료 시각 확인");
  const pct = ["할인율", "적립율"].includes(s("benefit")) || s("discountUnit") === "할인율(%)";
  if (pct) items.push("(할인율) 최대 할인금액 상한 재확인");
  if (ch.key === "naver") {
    if (s("benefitKind") === "포인트") items.push("(포인트) 적립율 15% 이하·최대 20만원, 유효기간 없음 확인");
    if (s("discountUnit") === "정률할인(%)") items.push("(정률) 최소주문금액×할인율 ≤ 최대할인금액 확인");
    if (deriveIssueMethod(answers) === "즉시발급") items.push("(즉시발급) 발급 후 회수 불가 — 대상·값 최종 확인");
    if (s("target") === "타겟팅-그룹") items.push("(그룹) 발급 방법(다운로드/즉시) 택1 확인");
    if (s("couponKind") === "스토어장바구니할인") items.push("(장바구니) 혜택상품 '내스토어 전체' 고정 확인");
    if (s("couponKind") === "배송비할인") items.push("(배송비) 최소주문금액은 판매가 기준(즉시할인 무관) 확인");
    if (s("target") === "타겟팅-고객지정") items.push("(고객지정) 고객ID 100명 이내·구매이력/알림동의 고객만 확인");
  }
  if (ch.key === "talk") {
    if (s("couponKind") === "장바구니 할인쿠폰") items.push("(장바구니) 적용 대상 '스토어 전체 상품' 고정 확인(스토어당 1개)");
    if (s("target") === "첫구매 고객") items.push("(첫구매) 적용 대상은 전체상품·카테고리만 — 상품/기획전 아닌지 확인");
    if (s("discountUnit") === "정률(%)") items.push("(정률) 할인율 1~99%·최대 할인금액 입력 확인");
    if (s("discountUnit") === "정액(원)") items.push("(정액) 할인액 10원 단위 확인");
    if (s("display") === "전시안함") items.push("(전시안함) 마케팅 메시지 수신 고객 전용 쿠폰인지 확인");
    items.push("(발행) 동일 기간 20개 이내인지, 계정당 1회 다운로드 조건 확인");
  }
  return items;
}

// 요청서 텍스트 생성 — Flow 태스크에 붙여넣을 형태(핵심 요약·상세 설정·위험 확인·체크리스트).
export function buildRequestText(ch: CouponChannel, answers: Answers, meta: { requester?: string; date: string }): string {
  const shown = ch.steps.flatMap((st) => st.fields).filter((f) => isFieldShown(f, answers, ch));
  const out: string[] = [];

  out.push(`[쿠폰 등록 요청서 · ${ch.label}]`);
  out.push(`요청자: ${meta.requester || "________"}  ·  요청일: ${meta.date}`);

  // ▼ 조기 노출 방지 배너 — 최상단·모든 채널(핵심 요약보다 먼저). MD가 절대 못 놓치게. ▼
  const expose = deriveExposeStart(ch, answers);
  if (expose.when) {
    const bar = "════════════════════════════════════════";
    if (expose.kind === "immediate" || expose.kind === "none") {
      out.push("", bar,
        `🔴 노출/발급 시작 : ${expose.when}  ← 지금 등록하면 고객에게 바로 나갑니다`,
        "   → 노출 예정일이 오늘이 아니라면 지금 등록하지 마세요.",
        "   → 예정일까지 기다리거나 [지정 기간 노출 / 발행대기]로 바꿔 등록하세요.",
        bar);
    } else if (expose.kind === "conditional") {
      out.push("", bar,
        `🕒 노출/발급 시작 : ${expose.when}`,
        "   → '노출 예정일'이 아니라 '조건(가입·후기·주기)' 시점에 발급됩니다.",
        "   → 조건/주기 설정을 지금 켜면 즉시 활성화됩니다. 원하는 시작일에 맞춰 활성화하세요.",
        bar);
    } else {
      out.push("", bar,
        `🕒 노출/발급 시작 : ${expose.when}`,
        "   → 이 시각 전에는 반드시 [발행대기 / 미노출] 상태로만 등록하세요.",
        "   → 예정일 전 미리 노출·발행 절대 금지 (대상 외 고객에게 혜택이 새어나갑니다).",
        bar);
    }
  }
  // ▲

  const core = shown.filter((f) => f.critical).map((f) => lineFor(f, answers)).filter((x): x is string => !!x);
  // 네이버 쿠폰: 발급 방법·적용일은 대상에서 자동 파생(필드 아님)이라 핵심 요약에 직접 추가(포인트는 발급방법 개념 없음).
  if (ch.key === "naver" && (typeof answers["benefitKind"] === "string" ? answers["benefitKind"] : "쿠폰") === "쿠폰") {
    const im = deriveIssueMethod(answers);
    if (im) core.push(`· 발급 방법(자동) : ${im}`);
    core.push(`· 적용일 : ${deriveApplyDay(answers)}`);
  }
  if (core.length) out.push("", "■ 핵심 요약 (먼저 확인)", ...core);

  const detail = shown.filter((f) => !f.critical).map((f) => lineFor(f, answers)).filter((x): x is string => !!x);
  if (detail.length) out.push("", "■ 상세 설정", ...detail);

  const risks = buildRisks(ch, answers);
  if (risks.length) out.push("", "⚠️ 위험 확인 (MD 필독)", ...risks.map((r) => `· ${r}`));

  out.push("", "── MD 등록 체크리스트 ──", ...buildChecklist(ch, answers).map((c) => `□ ${c}`));
  return out.join("\n");
}
