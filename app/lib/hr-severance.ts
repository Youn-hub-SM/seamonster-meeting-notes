// 퇴직금 — 화면과 서버가 같이 쓰는 타입·순수 계산. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  퇴직금 = 1일 평균임금 × 30 × (재직일수 ÷ 365)                         (근로자퇴직급여 보장법 제8조)
//  1일 평균임금 = (퇴직 전 3개월 임금총액 + 연간 상여금 × 3/12 + 연차수당 × 3/12) ÷ 그 3개월의 날수
//  평균임금이 통상임금보다 적으면 통상임금을 평균임금으로 본다                     (근로기준법 제2조 제2항)
//  계속근로기간이 1년 미만이거나 주 소정근로시간이 15시간 미만이면 지급 의무가 없다.
//
//  기준(바꾸면 금액이 달라진다):
//   · 퇴직일 = 마지막 근무일(인사대장의 퇴사일) 다음 날. 산정 기간 = 퇴직일 전 3개월(퇴직일의 3개월 전 같은 날 ~ 마지막 근무일).
//   · 3개월 임금은 그 달의 '저장된 급여'의 지급 합계에서 온다. 산정 기간이 그 달 재직 기간의 일부만 덮으면 날수로 나눈 추정이다
//     (산정 기간의 첫 달이 그렇다 — 화면에서 직접 고칠 수 있다). 퇴사한 달은 그 달 급여 전부가 산정 기간에 든다.
//   · 상여금처럼 1년치를 3/12 로 넣어야 하는 항목은 화면에서 골라 3개월 임금에서 빼고 연간 상여금으로 옮긴다(두 번 세지 않게).
//   · 1일 평균임금은 소수 둘째 자리까지, 퇴직금은 원 미만 올림.
//   · 통상임금(1일): 시급제 = 시급 × 하루 소정근로시간. 월급제 = 월급 ÷ 월 소정근로시간((주 소정 + 주휴) × 365 ÷ 7 ÷ 12, 주 40시간이면 209) × 하루 소정근로시간.
//  퇴직소득세는 계산하지 않는다.

import { numText } from "./hr";
import { addDays, monthRange, round2 } from "./hr-work";
import { addMonths } from "./hr-leave";

// 양 끝을 포함한 날수
export const dayCount = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

export type SevSegment = { month: string; from: string; to: string; days: number };
export type SevWindow = { from: string; to: string; days: number; segments: SevSegment[] };

// 마지막 근무일 → 평균임금 산정 기간. 달마다 나눈다. 입사한 지 3개월이 안 됐으면 입사일부터.
export function severanceWindow(lastDay: string, hireDate?: string): SevWindow {
  let from = addMonths(addDays(lastDay, 1), -3);
  if (hireDate && hireDate > from) from = hireDate;
  const segments: SevSegment[] = [];
  for (let d = from; d <= lastDay;) {
    const month = d.slice(0, 7);
    const end = monthRange(month).to < lastDay ? monthRange(month).to : lastDay;
    segments.push({ month, from: d, to: end, days: dayCount(d, end) });
    d = addDays(end, 1);
  }
  return { from, to: lastDay, days: from <= lastDay ? dayCount(from, lastDay) : 0, segments };
}

// 퇴직 전 1년(상여금을 더하는 기간)에 걸치는 달들 — 오래된 달부터
export function yearMonths(lastDay: string): string[] {
  const first = addMonths(addDays(lastDay, 1), -12).slice(0, 7), last = lastDay.slice(0, 7);
  const out: string[] = [];
  for (let m = first; m <= last; m = addMonths(`${m}-01`, 1).slice(0, 7)) out.push(m);
  return out;
}

// 서버가 주는 한 달: 그 달의 저장된 급여(이 직원의 줄)와 그 달에 재직한 기간
export type SevMonth = {
  month: string; status: "confirmed" | "draft" | "none";
  pay_total: number;
  items: { code: string; name: string; amount: number }[];        // 지급 항목(금액이 있는 것). 직접 넣는 항목은 code 가 "x:" 로 시작한다
  employed: { from: string; to: string; days: number } | null;
};

// 그 구간의 임금(자동으로 채우는 값)과 그 근거
export function segmentAuto(seg: SevSegment, m: SevMonth | undefined, bonusNames: Set<string>): { amount: number; source: string } {
  if (!m || m.status === "none" || !m.employed) return { amount: 0, source: "저장된 급여 없음" };
  const bonus = m.items.filter((i) => i.code.startsWith("x:") && bonusNames.has(i.name)).reduce((t, i) => t + i.amount, 0);
  const base = m.pay_total - bonus;
  const from = seg.from > m.employed.from ? seg.from : m.employed.from, to = seg.to < m.employed.to ? seg.to : m.employed.to;
  const days = from <= to ? dayCount(from, to) : 0;
  const label = `${m.status === "confirmed" ? "확정한 급여" : "저장한 급여(작성 중)"}의 지급 합계${bonus ? " − 상여" : ""}`;
  if (days >= m.employed.days) return { amount: base, source: label };
  return { amount: Math.round((base * days) / m.employed.days), source: `${label} ${numText(base)}원 × ${days}/${m.employed.days}일(날수로 나눈 추정)` };
}

// 퇴직 전 1년에 직접 넣은 지급 항목(상여 후보) — 이름마다 합계와 횟수. 큰 순.
export function bonusCandidates(months: SevMonth[]): { name: string; total: number; count: number }[] {
  const by = new Map<string, { name: string; total: number; count: number }>();
  for (const m of months) for (const i of m.items) {
    if (!i.code.startsWith("x:") || !(i.amount > 0)) continue;
    const c = by.get(i.name) || { name: i.name, total: 0, count: 0 };
    c.total += i.amount; c.count++;
    by.set(i.name, c);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ko"));
}
export const bonusTotal = (months: SevMonth[], names: Set<string>): number =>
  months.reduce((t, m) => t + m.items.filter((i) => i.code.startsWith("x:") && names.has(i.name)).reduce((s, i) => s + i.amount, 0), 0);

// 1일 통상임금
export function ordinaryDaily(
  e: { pay_type: "hourly" | "monthly"; daily_hours: number; work_days: number[] },
  wage: { hourly_wage: number; monthly_wage: number } | null, weeklyHoliday: number,
): { hourly: number; daily: number; calc: string } {
  const daily = e.daily_hours || 0;
  if (!wage || !(daily > 0)) return { hourly: 0, daily: 0, calc: "" };
  if (e.pay_type === "hourly") {
    if (!(wage.hourly_wage > 0)) return { hourly: 0, daily: 0, calc: "" };
    return { hourly: wage.hourly_wage, daily: Math.round(wage.hourly_wage * daily), calc: `시급 ${numText(wage.hourly_wage)}원 × ${daily}시간` };
  }
  const weekly = Math.min(40, daily * e.work_days.length);
  const monthlyHours = Math.round(((weekly + weeklyHoliday) * 365) / 7 / 12);
  if (!(wage.monthly_wage > 0) || !(monthlyHours > 0)) return { hourly: 0, daily: 0, calc: "" };
  const hourly = wage.monthly_wage / monthlyHours;
  return { hourly: round2(hourly), daily: Math.round(hourly * daily), calc: `월급 ${numText(wage.monthly_wage)}원 ÷ ${monthlyHours}시간 × ${daily}시간` };
}

export type SevInput = {
  segments: { days: number; amount: number }[];
  bonusYear: number;        // 퇴직 전 1년 동안 받은 상여금 총액
  leavePay: number;         // 연차수당(퇴직 전 1년 안에 받은 것)
  serviceDays: number;      // 재직일수(입사일 ~ 마지막 근무일)
  ordinaryDaily: number;    // 1일 통상임금(모르면 0)
  weeklyHours: number;      // 주 소정근로시간(지급 의무 판단에만 쓴다)
};
export type SevResult = {
  wage3m: number; added: number; days3m: number;
  avgDaily: number; ordinaryDaily: number; usedDaily: number; usedOrdinary: boolean;
  severance: number;
  eligible: boolean; reasons: string[];
};
export function calcSeverance(a: SevInput): SevResult {
  const wage3m = a.segments.reduce((t, s) => t + (Math.round(s.amount) || 0), 0);
  const days3m = a.segments.reduce((t, s) => t + s.days, 0);
  const added = Math.round(((Math.max(0, a.bonusYear) + Math.max(0, a.leavePay)) * 3) / 12);
  const avgDaily = days3m > 0 ? round2((wage3m + added) / days3m) : 0;
  const usedOrdinary = a.ordinaryDaily > avgDaily;
  const usedDaily = usedOrdinary ? a.ordinaryDaily : avgDaily;
  // 소수 오차로 1원이 더 붙지 않게 0.01 원까지 맞춘 뒤 올린다
  const severance = a.serviceDays > 0 ? Math.ceil(Math.round(((usedDaily * 30 * a.serviceDays) / 365) * 100) / 100) : 0;
  const reasons: string[] = [];
  if (a.serviceDays < 365) reasons.push(`계속근로기간이 1년 미만입니다(재직 ${numText(a.serviceDays)}일). 퇴직금 지급 의무가 없습니다.`);
  if (a.weeklyHours > 0 && a.weeklyHours < 15) reasons.push(`주 소정근로시간이 15시간 미만입니다(직원 정보 기준 주 ${a.weeklyHours}시간). 퇴직금 지급 의무가 없습니다.`);
  return { wage3m, added, days3m, avgDaily, ordinaryDaily: a.ordinaryDaily, usedDaily, usedOrdinary, severance, eligible: reasons.length === 0, reasons };
}

// 화면이 받는 묶음(GET /api/hr/severance?employee=)
export type SevEmployee = {
  id: string; workplace_id: string; workplace: string; emp_no: string; name: string; dept: string; position: string;
  birth_date: string | null; hire_date: string; leave_date: string | null;
  pay_type: "hourly" | "monthly"; daily_hours: number; work_days: number[];
};
export type SevBundle = {
  employee: SevEmployee;
  last_day: string;                          // 계산에 쓴 마지막 근무일
  months: SevMonth[];                        // 퇴직 전 1년에 걸치는 달(오래된 달부터)
  ordinary: { hourly: number; daily: number; calc: string };
  weekly_hours: number;
};
export type SevPick = { id: string; workplace: string; emp_no: string; name: string; dept: string; position: string; birth_date: string | null; hire_date: string; leave_date: string | null };
