// 증명서 — 화면과 서버가 같이 쓰는 타입·순수 함수. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  서류 4가지. 내용은 전부 이미 있는 자료에서 읽는다(인사대장·사업장·확정한 월 급여) — 증명서용으로 따로 저장하는 값이 없다.
//   · 재직증명서: 재직 중인 직원. 성명·생년월일(또는 주민등록번호)·주소·부서·직위·입사일·재직 기간.
//   · 경력증명서: 재직자·퇴사자. 근무 기간·부서·직위·담당 업무.
//   · 갑종근로소득에 대한 소득세 원천징수증명서: 고른 기간의 달별 급여액과 원천징수한 소득세·지방소득세.
//       **급여를 확정한 달만** 나온다. 연말정산으로 확정한 결정세액이 아니라 달마다 실제로 뗀 세금이다
//       (연말정산용 '근로소득 원천징수영수증'은 이 창의 자료로 만들 수 없다).
//  용도·제출처·발급일은 발급할 때 넣고 저장하지 않는다. 발급한 사실은 hr.audit_log 에 남고, 그 줄의 번호가 발급 번호다.

import { WEEKDAYS, currentWage, numText, wageOn, type Employee, type Workplace } from "./hr";

//   · 근로계약서(2026-11-23): 인사대장의 근로 조건(계약 기간·근무 시간·임금·4대보험)과 사업장 정보로 채운 표준 모양의 계약서.
//       기간·장소·업무·상여금·수당·지급일·특약은 인쇄하기 전에 고칠 수 있고 저장하지 않는다(인사대장을 바꾸지 않는다).
export const DOC_KINDS = ["employment", "career", "withholding", "contract"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_LABEL: Record<DocKind, string> = {
  employment: "재직증명서", career: "경력증명서", withholding: "갑종근로소득에 대한 소득세 원천징수증명서", contract: "근로계약서",
};
export const DOC_TAB: Record<DocKind, string> = { employment: "재직증명서", career: "경력증명서", withholding: "원천징수증명서", contract: "근로계약서" };

export type WithholdingRow = {
  month: string; pay_date: string;
  pay_total: number; exempt_total: number; taxable_total: number; income_tax: number; local_tax: number;
};
export const sumWithholding = (rows: WithholdingRow[]) => rows.reduce(
  (t, r) => ({ pay_total: t.pay_total + r.pay_total, exempt_total: t.exempt_total + r.exempt_total, taxable_total: t.taxable_total + r.taxable_total, income_tax: t.income_tax + r.income_tax, local_tax: t.local_tax + r.local_tax }),
  { pay_total: 0, exempt_total: 0, taxable_total: 0, income_tax: 0, local_tax: 0 },
);

// 발급 번호: 발급한 해 + 이력 줄 번호(6자리). 예: 제 2026-000123 호
export const issueNo = (issueDate: string, auditId: number): string => `${issueDate.slice(0, 4)}-${String(auditId).padStart(6, "0")}`;
// 2026-11-21 → 2026년 11월 21일
export const dateKo = (d: string | null | undefined): string => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(0, 4))}년 ${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일` : "");
export const monthKo = (m: string): string => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5, 7))}월`;

// ── 근로계약서 ──────────────────────────────────────────────────────
// 고용노동부 표준근로계약서의 짜임(근로기준법 제17조가 적으라고 한 것: 임금의 구성항목·계산방법·지급방법, 소정근로시간, 휴일, 연차유급휴가 등)을 따른다.
//  인쇄하기 전에 고칠 수 있는 값(ContractInput)은 저장하지 않는다 — 인사대장의 값이 틀렸으면 인사대장을 고친다.
export type ContractInput = {
  date: string;                 // 계약일(계약서 아래에 찍히는 날)
  start: string; end: string;   // 근로계약기간. end 가 비면 '기간의 정함이 없음'
  place: string;                // 근무 장소
  job: string;                  // 업무의 내용
  weeklyRest: number;           // 주휴일 요일(1=월 … 7=일)
  bonus: string;                // 상여금("" = 없음. 금액이나 조건을 글로)
  allowances: string;           // 기타 급여·제수당("" = 없음)
  payday: number;               // 임금 지급일(매월 n일)
  payMethod: "bank" | "cash";   // 근로자 명의 예금통장에 입금 / 근로자에게 직접 지급
  special: string;              // 특약 사항("" = 없음)
};
export type ContractClause = { title: string; lines: string[]; checks?: { label: string; on: boolean }[] };

// 처음 값: 인사대장과 사업장에서. 주휴일은 일하지 않는 요일 가운데 일요일을 먼저 고른다.
export function contractDefaults(e: Employee, wp: Workplace, today: string): ContractInput {
  const off = [7, 6, 5, 4, 3, 2, 1].find((d) => !e.work_days.includes(d)) || 7;
  return {
    date: today, start: e.contract_start || e.hire_date || today, end: e.contract_end || "",
    place: wp.address || wp.name, job: e.job || e.dept || "",
    weeklyRest: off, bonus: "", allowances: "",
    payday: wp.payday || 10, payMethod: e.account_no ? "bank" : "cash", special: "",
  };
}
export function contractProblem(c: ContractInput): string {
  const isD = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!isD(c.date)) return "계약일을 입력하세요";
  if (!isD(c.start)) return "근로 시작일을 입력하세요";
  if (c.end && !isD(c.end)) return "근로 종료일이 날짜가 아닙니다";
  if (c.end && c.end < c.start) return "근로 종료일이 시작일보다 앞입니다";
  if (!(c.payday >= 1 && c.payday <= 31)) return "임금 지급일은 1~31";
  return "";
}

// 계약서의 조항들. 임금은 근로 시작일에 유효한 임금 줄(없으면 지금 임금).
export function contractClauses(e: Employee, wp: Workplace, c: ContractInput): ContractClause[] {
  const w = wageOn(e.wages, c.start) || currentWage(e.wages);
  const wageLine = e.pay_type === "hourly"
    ? `시간급: ${w?.hourly_wage ? `${numText(w.hourly_wage)}원` : "         원"}`
    : `월급: ${w?.monthly_wage ? `${numText(w.monthly_wage)}원` : "         원"}`;
  const days = [...e.work_days].sort((a, b) => a - b);
  const weekly = Math.round(e.daily_hours * days.length * 100) / 100;
  const hours = e.work_start && e.work_end
    ? `${e.work_start}부터 ${e.work_end}까지 (휴게시간 ${e.break_min}분, 1일 ${e.daily_hours}시간)`
    : `1일 ${e.daily_hours}시간 (휴게시간 ${e.break_min}분)`;
  return [
    { title: "근로계약기간", lines: [c.end ? `${dateKo(c.start)}부터 ${dateKo(c.end)}까지` : `${dateKo(c.start)}부터 (기간의 정함이 없음)`] },
    { title: "근무 장소", lines: [c.place] },
    { title: "업무의 내용", lines: [c.job] },
    { title: "소정근로시간", lines: [hours] },
    { title: "근무일·휴일", lines: [
      `매주 ${days.length}일(${days.map((d) => WEEKDAYS[d - 1]).join("·")}) 근무, 주 ${weekly}시간`,
      weekly >= 15 ? `주휴일: 매주 ${WEEKDAYS[c.weeklyRest - 1] || "일"}요일` : "주휴일: 해당 없음(주 소정근로시간 15시간 미만)",
    ] },
    { title: "임금", lines: [
      wageLine,
      `상여금: ${c.bonus.trim() ? `있음 (${c.bonus.trim()})` : "없음"}`,
      `기타 급여(제수당 등): ${c.allowances.trim() ? `있음 (${c.allowances.trim()})` : "없음"}`,
      `임금 지급일: 매월 ${c.payday}일 (휴일인 경우 전일 지급)`,
      `지급 방법: ${c.payMethod === "bank" ? "근로자 명의 예금통장에 입금" : "근로자에게 직접 지급"}`,
    ] },
    { title: "연차유급휴가", lines: ["연차유급휴가는 근로기준법에서 정하는 바에 따라 부여한다."] },
    { title: "사회보험 적용 여부", lines: [], checks: [
      { label: "고용보험", on: e.ins_employment }, { label: "산재보험", on: true }, { label: "국민연금", on: e.ins_pension }, { label: "건강보험", on: e.ins_health },
    ] },
    { title: "근로계약서 교부", lines: ["사업주는 근로계약을 체결함과 동시에 본 계약서를 사본하여 근로자의 교부 요구와 관계없이 근로자에게 교부한다(근로기준법 제17조 이행)."] },
    { title: "근로계약, 취업규칙 등의 성실한 이행 의무", lines: ["사업주와 근로자는 각자가 근로계약, 취업규칙, 단체협약을 지키고 성실하게 이행하여야 한다."] },
    { title: "기타", lines: ["이 계약에 정함이 없는 사항은 근로기준법령에 의한다.", ...(c.special.trim() ? c.special.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [])] },
  ];
}

// 직인 이미지: PNG·JPEG, 약 500KB 까지(data URL 글자 수로 본다 — DB 의 확인과 같은 기준)
export const STAMP_MAX_CHARS = 700000;
export const isStampDataUrl = (s: unknown): s is string => typeof s === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= STAMP_MAX_CHARS;
