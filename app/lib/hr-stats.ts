// 통계 — 화면과 서버가 같이 쓰는 타입·순수 집계. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  새로 저장하는 것은 없다. 이미 있는 기록(월 급여·근무대장·인사대장·연차 발생 건)을 달마다 더하기만 한다.
//  기준(바꾸면 숫자가 달라진다):
//   · 기간 = 끝 달을 포함한 12개월.
//   · 인건비 = 지급 합계 + 회사 부담 4대보험. **확정한 달만** 더한다 — 작성 중인 달은 금액이 바뀔 수 있어 따로 보여 준다.
//   · 근무 시간 = 근무대장을 hr-work.ts(summarizeMonth)로 계산한 값. 급여 화면과 같은 함수라 숫자가 같다.
//   · 재직 인원 = 그 달 말일(진행 중인 달은 오늘)에 재직한 사람 수. 입사·퇴사 = 그 달에 입사일·퇴사일이 있는 사람 수.
//   · 연차 = 오늘 기준(hr-leave.ts summarizeLeave). 달별 사용 일수는 근무대장의 연차 줄.

import { isActiveOn } from "./hr";
import { monthRange, round2, shiftMonth, summarizeMonth, type WorkEmployee, type WorkLog, type WorkPlace } from "./hr-work";
import { summarizeLeave, type LeaveGrant, type LeaveUse } from "./hr-leave";

export type StatsEmployee = WorkEmployee & { id: string; workplace_id: string; emp_no: string; name: string; emp_type: string; pay_type: "hourly" | "monthly"; affiliation: string };

// 끝 달을 포함한 n개월(오래된 달부터)
export function monthsEnding(end: string, n = 12): string[] {
  return Array.from({ length: n }, (_, i) => shiftMonth(end, i - (n - 1)));
}
export const monthLabel = (m: string): string => `${Number(m.slice(5))}월`;

// ── 인건비 ──────────────────────────────────────────────────────────
export type CostAgg = {
  people: number; pay_total: number; deduct_total: number; net_pay: number; employer: number;
  base: number; weekly: number; premium: number; paid_leave: number; extra: number;   // 지급 합계의 구성(합 = pay_total)
};
export type CostMonth = { month: string; confirmed: CostAgg | null; draft: CostAgg | null };
export type CostPayroll = { id: string; month: string; status: "draft" | "confirmed" };
export type CostLine = {
  payroll_id: string; employee_id: string; pay_total: number; deduct_total: number; net_pay: number; employer_total: number;
  items: { code: string; kind: string; amount: number }[];
};
// 소속별 인건비 — 기간 안의 **확정한 달만** 더한 것. 소속은 지금 인사대장의 값(그때의 소속이 아니다). name "" = 소속을 정하지 않은 직원
export type AffCost = { name: string; people: number; pay_total: number; employer: number };
export function costByAffiliation(payrolls: CostPayroll[], lines: CostLine[], months: string[], affOf: Map<string, string>): AffCost[] {
  const ok = new Set(payrolls.filter((p) => p.status === "confirmed" && months.includes(p.month)).map((p) => p.id));
  const by = new Map<string, AffCost & { ids: Set<string> }>();
  for (const l of lines) {
    if (!ok.has(l.payroll_id)) continue;
    const name = affOf.get(l.employee_id) || "";
    let a = by.get(name);
    if (!a) by.set(name, a = { name, people: 0, pay_total: 0, employer: 0, ids: new Set() });
    a.ids.add(l.employee_id); a.pay_total += l.pay_total; a.employer += l.employer_total;
  }
  return [...by.values()].map((a) => ({ name: a.name, people: a.ids.size, pay_total: a.pay_total, employer: a.employer }))
    .sort((x, y) => (y.pay_total + y.employer) - (x.pay_total + x.employer));
}
const emptyAgg = (): CostAgg => ({ people: 0, pay_total: 0, deduct_total: 0, net_pay: 0, employer: 0, base: 0, weekly: 0, premium: 0, paid_leave: 0, extra: 0 });

export function costStats(payrolls: CostPayroll[], lines: CostLine[], months: string[]): CostMonth[] {
  const byMonth = new Map<string, CostMonth>(months.map((m) => [m, { month: m, confirmed: null, draft: null }]));
  const payOf = new Map(payrolls.map((p) => [p.id, p]));
  for (const l of lines) {
    const p = payOf.get(l.payroll_id);
    const row = p ? byMonth.get(p.month) : undefined;
    if (!p || !row) continue;
    const a = (row[p.status] ||= emptyAgg());
    a.people++; a.pay_total += l.pay_total; a.deduct_total += l.deduct_total; a.net_pay += l.net_pay; a.employer += l.employer_total;
    for (const i of l.items || []) {
      if (i.kind !== "pay") continue;
      const amt = Number(i.amount) || 0;
      if (i.code === "base") a.base += amt;
      else if (i.code === "weekly") a.weekly += amt;
      else if (i.code === "overtime" || i.code === "night" || i.code === "holiday") a.premium += amt;
      else if (i.code === "paid_leave") a.paid_leave += amt;
      else a.extra += amt;
    }
  }
  return months.map((m) => byMonth.get(m)!);
}

// ── 근무 시간 ───────────────────────────────────────────────────────
export type HoursMonth = {
  month: string; people: number;   // 그 달에 하루라도 일한 사람
  worked: number; overtime: number; night: number; holiday: number; weekly: number; leaveDays: number; absentDays: number;
};
export type HoursPerson = { id: string; emp_no: string; name: string; worked: number; overtime: number; night: number; holiday: number; absentDays: number };

export function hoursStats(
  employees: StatsEmployee[], wpOf: Map<string, WorkPlace>, logs: (WorkLog & { employee_id: string })[], months: string[],
): { byMonth: HoursMonth[]; byPerson: HoursPerson[] } {
  const logsOf = new Map<string, WorkLog[]>();
  for (const l of logs) { if (!logsOf.has(l.employee_id)) logsOf.set(l.employee_id, []); logsOf.get(l.employee_id)!.push(l); }
  const byMonth: HoursMonth[] = months.map((m) => ({ month: m, people: 0, worked: 0, overtime: 0, night: 0, holiday: 0, weekly: 0, leaveDays: 0, absentDays: 0 }));
  const byPerson: HoursPerson[] = [];
  for (const e of employees) {
    const wp = wpOf.get(e.workplace_id);
    const mine = logsOf.get(e.id);
    if (!wp || !mine || mine.length === 0) continue;
    const p: HoursPerson = { id: e.id, emp_no: e.emp_no, name: e.name, worked: 0, overtime: 0, night: 0, holiday: 0, absentDays: 0 };
    months.forEach((m, i) => {
      const { from, to } = monthRange(m);
      if (e.hire_date > to || (e.leave_date && e.leave_date < from)) return;
      const s = summarizeMonth(e, wp, mine, m);
      const hol = s.holidayBase + s.holidayOver;
      const row = byMonth[i];
      if (s.workDays > 0) row.people++;
      row.worked += s.worked; row.overtime += s.overtime; row.night += s.night; row.holiday += hol; row.weekly += s.weeklyHours;
      row.leaveDays += s.leaveDays; row.absentDays += s.absentDays;
      p.worked += s.worked; p.overtime += s.overtime; p.night += s.night; p.holiday += hol; p.absentDays += s.absentDays;
    });
    for (const k of ["worked", "overtime", "night", "holiday"] as const) p[k] = round2(p[k]);
    if (p.worked > 0 || p.absentDays > 0) byPerson.push(p);
  }
  for (const r of byMonth) for (const k of ["worked", "overtime", "night", "holiday", "weekly", "leaveDays"] as const) r[k] = round2(r[k]);
  return { byMonth, byPerson };
}

// ── 인원 ────────────────────────────────────────────────────────────
export type PeopleMonth = { month: string; active: number; hired: number; left: number };
export type PeopleMix = { empType: [string, number][]; payType: [string, number][]; tenure: [string, number][]; active: number };
export const TENURE_BUCKETS = ["1년 미만", "1~3년", "3~5년", "5~10년", "10년 이상"] as const;
const tenureOf = (hire: string, on: string): number => {
  let months = (Number(on.slice(0, 4)) - Number(hire.slice(0, 4))) * 12 + (Number(on.slice(5, 7)) - Number(hire.slice(5, 7)));
  if (on.slice(8) < hire.slice(8)) months--;
  const y = months / 12;
  return y < 1 ? 0 : y < 3 ? 1 : y < 5 ? 2 : y < 10 ? 3 : 4;
};
const refDate = (month: string, today: string): string => { const { to } = monthRange(month); return to > today ? today : to; };

export function peopleStats(employees: StatsEmployee[], months: string[], today: string): { byMonth: PeopleMonth[]; mix: PeopleMix } {
  const byMonth = months.map((m) => {
    const { from, to } = monthRange(m);
    const on = refDate(m, today);
    const future = from > today;
    return {
      month: m,
      active: future ? 0 : employees.filter((e) => isActiveOn(e, on)).length,
      hired: employees.filter((e) => e.hire_date >= from && e.hire_date <= to && e.hire_date <= today).length,
      left: employees.filter((e) => e.leave_date && e.leave_date >= from && e.leave_date <= to && e.leave_date <= today).length,
    };
  });
  const last = months[months.length - 1];
  const on = refDate(last, today);
  const now = employees.filter((e) => isActiveOn(e, on));
  const count = (key: (e: StatsEmployee) => string, order?: readonly string[]): [string, number][] => {
    const m = new Map<string, number>();
    for (const e of now) m.set(key(e), (m.get(key(e)) || 0) + 1);
    const rows = [...m].filter(([, n]) => n > 0);
    return order ? order.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as [string, number]) : rows.sort((a, b) => b[1] - a[1]);
  };
  return {
    byMonth,
    mix: {
      active: now.length,
      empType: count((e) => e.emp_type || "미입력"),
      payType: count((e) => (e.pay_type === "monthly" ? "월급" : "시급"), ["시급", "월급"]),
      tenure: count((e) => TENURE_BUCKETS[tenureOf(e.hire_date, on)], TENURE_BUCKETS),
    },
  };
}

// ── 연차(오늘 기준) ─────────────────────────────────────────────────
export type LeavePerson = { id: string; emp_no: string; name: string; granted: number; used: number; left: number; expiring: number };
export type LeaveStats = { people: number; granted: number; used: number; left: number; expiring: number; byPerson: LeavePerson[] };

export function leaveStats(employees: StatsEmployee[], grants: LeaveGrant[], uses: LeaveUse[], today: string): LeaveStats {
  const g = new Map<string, LeaveGrant[]>(), u = new Map<string, LeaveUse[]>();
  for (const x of grants) { if (!g.has(x.employee_id)) g.set(x.employee_id, []); g.get(x.employee_id)!.push(x); }
  for (const x of uses) { if (!u.has(x.employee_id)) u.set(x.employee_id, []); u.get(x.employee_id)!.push(x); }
  const out: LeaveStats = { people: 0, granted: 0, used: 0, left: 0, expiring: 0, byPerson: [] };
  for (const e of employees) {
    if (!isActiveOn(e, today)) continue;
    const s = summarizeLeave(g.get(e.id) || [], u.get(e.id) || [], today);
    if (s.granted === 0 && s.used === 0) continue;
    out.people++; out.granted += s.granted; out.used += s.used; out.left += s.left; out.expiring += s.expiring;
    out.byPerson.push({ id: e.id, emp_no: e.emp_no, name: e.name, granted: s.granted, used: s.used, left: s.left, expiring: s.expiring });
  }
  for (const k of ["granted", "used", "left", "expiring"] as const) out[k] = round2(out[k]);
  return out;
}

// ── 화면이 받는 묶음(GET /api/hr/stats) ─────────────────────────────
export type StatsBundle = {
  end: string; months: string[]; today: string;
  workplace_id: string;                       // "" = 모든 사업장
  workplaces: { id: string; name: string }[];
  affiliation: string;                        // "" = 모든 소속
  affiliations: string[];                     // 고를 수 있는 소속(그 기간 직원에게 들어 있는 이름)
  costByAff: AffCost[] | null;                // 소속별 인건비 — 소속을 쓰지 않거나 소속 하나를 골랐으면 null
  cost: CostMonth[] | null;                   // null = 급여 표가 아직 없다(hr/003 미적용)
  hours: { byMonth: HoursMonth[]; byPerson: HoursPerson[] };
  people: { byMonth: PeopleMonth[]; mix: PeopleMix };
  leave: LeaveStats | null;                   // null = 연차 표가 아직 없다(hr/004 미적용)
};
