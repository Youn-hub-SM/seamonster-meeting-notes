// 첫 화면(대시보드) — 화면과 서버가 같이 쓰는 타입·순수 계산. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  세 구역: 오늘의 근무 현황 · 세무 일정 · 해야 할 일. 읽기만 한다(여기서 저장하는 것이 없다).
//  기준(바꾸면 화면의 숫자·줄이 달라진다):
//   · 근무 예정 = 오늘 재직 중이고, 오늘이 소정근로 요일이고, 쉬는 날(휴무일)·종일 연차·결근이 아닌 직원.
//       출근 기록(세콤 등)은 근무대장에 올려야 보이므로 '지금 출근했는가'가 아니다 — 오늘 근무대장에 줄이 있으면 그 인원을 따로 보여 준다.
//   · 세무 일정: 원천세는 매월 낸다(2026-11-23 대표). 지급한 달의 다음 달 10일, 그날이 토·일·공휴일이면 다음 영업일.
//       금액은 확정한 급여의 소득세·지방소득세 합(작성 중인 급여는 건수만 알린다).
//       날짜가 정해진 일정(TAX_FIXED)은 법이 바뀌면 고친다 — 세무사 확인 대상.
//   · 해야 할 일의 '지금'은 기한이 지났거나 7일 안인 것. 그 밖은 '곧'.

import { numText } from "./hr";
import { addDays, leaveText, monthRange, shiftMonth, weekdayOf } from "./hr-work";
import { dayOffsOf, fillKindOf, type Holiday, type HolidayKind } from "./hr-holidays";
import { defaultPayDate } from "./hr-pay";
import type { TaxRow } from "./hr-tax";

export type HomeEmployee = {
  id: string; workplace_id: string; name: string; affiliation: string; pay_type: "hourly" | "monthly";
  hire_date: string; leave_date: string | null; contract_end: string | null;
  work_days: number[]; daily_hours: number;
  hourly_wage: number;   // 오늘 유효한 시급(시급제만. 없으면 0)
};
export type HomeWorkplace = { id: string; name: string; payday: number; active: boolean; five_plus: boolean };
export type HomeLog = { employee_id: string; work_date: string; kind: string; hours: number; leave_days: number };
export type HomePayroll = { workplace_id: string; month: string; pay_date: string; status: "confirmed" | "draft" };

// ── 날짜 ────────────────────────────────────────────────────────────
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const diffDays = (from: string, to: string): number => Math.round((ms(to) - ms(from)) / 86400000);
// 11월 23일
export const mdText = (d: string): string => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const monthNo = (m: string): string => `${Number(m.slice(5, 7))}월`;
// 기한까지: "D-3" · "오늘" · "3일 지남"
export function ddayText(today: string, date: string): string {
  const n = diffDays(today, date);
  return n === 0 ? "오늘" : n > 0 ? `D-${n}` : `${-n}일 지남`;
}
// 토·일·공휴일이면 다음 영업일로
export function nextBusinessDay(d: string, holidays: ReadonlySet<string>): string {
  let x = d;
  while (weekdayOf(x) >= 6 || holidays.has(x)) x = addDays(x, 1);
  return x;
}
const activeOn = (e: Pick<HomeEmployee, "hire_date" | "leave_date">, on: string) => e.hire_date <= on && (!e.leave_date || e.leave_date >= on);
// "김파도, 박바다 외 2명"
export function namesText(names: string[], show = 3): string {
  return names.length <= show ? names.join(", ") : `${names.slice(0, show).join(", ")} 외 ${names.length - show}명`;
}

// ── 오늘의 근무 현황 ────────────────────────────────────────────────
export type TodayPerson = { id: string; name: string; workplace: string; text: string };
export type TodayStatus = {
  date: string; weekday: number;
  active: number;        // 재직 인원
  scheduled: number;     // 근무 예정
  logged: number;        // 오늘 근무대장에 근무 줄이 있는 인원
  byWorkplace: { id: string; name: string; active: number; scheduled: number }[];
  onLeave: TodayPerson[];   // 오늘 연차(시간 단위 포함)
  absent: TodayPerson[];    // 오늘 결근으로 적힌 직원
  dayOff: { name: string; kind: HolidayKind; people: number }[];   // 오늘 걸린 쉬는 날과 그날 쉬는 인원
  upcoming: (TodayPerson & { date: string })[];   // 내일부터 7일 안의 연차
};

export function todayStatus(args: { today: string; workplaces: HomeWorkplace[]; employees: HomeEmployee[]; logs: HomeLog[]; holidays: Holiday[] }): TodayStatus {
  const { today, workplaces, employees, logs, holidays } = args;
  const weekday = weekdayOf(today);
  const wpOf = new Map(workplaces.map((w) => [w.id, w]));
  const multi = workplaces.length > 1;
  const wpName = (id: string) => (multi ? wpOf.get(id)?.name || "" : "");
  const empOf = new Map(employees.map((e) => [e.id, e]));
  const todayLog = new Map(logs.filter((l) => l.work_date === today).map((l) => [l.employee_id, l]));

  const staff = employees.filter((e) => activeOn(e, today));
  const by = new Map<string, { id: string; name: string; active: number; scheduled: number }>();
  const offs = new Map<string, { name: string; kind: HolidayKind; people: number }>();
  let scheduled = 0, logged = 0;
  const onLeave: TodayPerson[] = [], absent: TodayPerson[] = [];
  for (const e of staff) {
    const wp = wpOf.get(e.workplace_id);
    if (!by.has(e.workplace_id)) by.set(e.workplace_id, { id: e.workplace_id, name: wp?.name || "", active: 0, scheduled: 0 });
    const row = by.get(e.workplace_id)!;
    row.active++;
    const log = todayLog.get(e.id);
    const off = dayOffsOf(holidays, e.workplace_id, e.affiliation)[today];
    const isOff = !!fillKindOf(off, today, wp?.five_plus ?? true);   // 5인 미만 사업장의 공휴일은 평소 근무일
    const workday = e.work_days.includes(weekday);
    if (off && isOff && workday) {
      const k = `${off.kind}:${off.name}`;
      offs.set(k, { name: off.name, kind: off.kind, people: (offs.get(k)?.people || 0) + 1 });
    }
    const leave = log && log.leave_days > 0 ? leaveText(log.leave_days, e.daily_hours) : "";
    if (leave) onLeave.push({ id: e.id, name: e.name, workplace: wpName(e.workplace_id), text: leave });
    if (log?.kind === "absent") absent.push({ id: e.id, name: e.name, workplace: wpName(e.workplace_id), text: "결근" });
    if (log && (log.kind === "work" || log.kind === "holiday_work") && log.hours > 0) logged++;
    const fullLeave = !!log && (log.kind === "leave" || log.leave_days >= 1);
    if (workday && !isOff && !fullLeave && log?.kind !== "absent") { scheduled++; row.scheduled++; }
  }
  const upcoming = logs
    .filter((l) => l.work_date > today && l.leave_days > 0 && empOf.has(l.employee_id))
    .map((l) => { const e = empOf.get(l.employee_id)!; return { id: e.id, date: l.work_date, name: e.name, workplace: wpName(e.workplace_id), text: leaveText(l.leave_days, e.daily_hours) }; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "ko"));
  const order = (id: string) => { const i = workplaces.findIndex((w) => w.id === id); return i < 0 ? workplaces.length : i; };
  const byName = (a: TodayPerson, b: TodayPerson) => a.name.localeCompare(b.name, "ko");
  return {
    date: today, weekday, active: staff.length, scheduled, logged,
    byWorkplace: [...by.values()].sort((a, b) => order(a.id) - order(b.id)),
    onLeave: onLeave.sort(byName), absent: absent.sort(byName),
    dayOff: [...offs.values()].sort((a, b) => b.people - a.people || a.name.localeCompare(b.name, "ko")),
    upcoming,
  };
}

// ── 세무 일정 ───────────────────────────────────────────────────────
export type TaxEvent = {
  key: string;
  date: string;         // 실제 기한(휴일이면 밀린 날)
  moved: boolean;       // 휴일이라 밀렸는가
  title: string; detail: string;
  amount: number | null;   // 낼 금액(원천세만. 확정한 급여가 없으면 null)
  href: string;
  dday: number;
};
// 날짜가 정해진 일정(월-일). 법이 바뀌면 여기를 고친다.
export const TAX_FIXED: { md: string; title: string; detail: string }[] = [
  { md: "01-31", title: "간이지급명세서(근로소득) 제출", detail: "지난해 7~12월 지급분" },
  { md: "03-10", title: "근로소득 지급명세서 제출", detail: "지난해 귀속 연말정산" },
  { md: "07-31", title: "간이지급명세서(근로소득) 제출", detail: "1~6월 지급분" },
];
export const TAX_HORIZON = 75;   // 오늘부터 며칠 앞까지 보여 주나

export function taxSchedule(args: { today: string; rows: TaxRow[]; holidays: ReadonlySet<string>; horizon?: number }): TaxEvent[] {
  const { today, rows, holidays } = args;
  const until = addDays(today, args.horizon ?? TAX_HORIZON);
  const out: TaxEvent[] = [];
  const push = (key: string, raw: string, title: string, detail: string, amount: number | null, href: string) => {
    const date = nextBusinessDay(raw, holidays);
    if (date < today || date > until) return;
    out.push({ key, date, moved: date !== raw, title, detail, amount, href, dday: diffDays(today, date) });
  };
  // 매월 10일: 앞 달에 지급한 급여의 원천세, 앞 달분 4대보험료
  for (let m = shiftMonth(today.slice(0, 7), -1); m <= until.slice(0, 7); m = shiftMonth(m, 1)) {
    const raw = `${m}-10`, payMonth = shiftMonth(m, -1);
    const paid = rows.filter((r) => r.pay_month === payMonth);
    const done = paid.filter((r) => r.status === "confirmed"), draft = paid.length - done.length;
    const income = done.reduce((t, r) => t + r.income_tax, 0), local = done.reduce((t, r) => t + r.local_tax, 0);
    const detail = done.length > 0
      ? `${monthNo(payMonth)} 지급분 · 소득세 ${numText(income)}원 · 지방소득세 ${numText(local)}원${draft > 0 ? ` · 확정 전 급여 ${draft}건 제외` : ""}`
      : draft > 0 ? `${monthNo(payMonth)} 지급분 · 확정 전 급여 ${draft}건` : `${monthNo(payMonth)} 지급분 · 지급한 급여 없음`;
    push(`withholding:${m}`, raw, "원천세 신고·납부", detail, done.length > 0 ? income + local : null, "/hr/tax");
    push(`insurance:${m}`, raw, "4대보험료 납부", `${monthNo(payMonth)}분 고지`, null, `/hr/pay?month=${payMonth}`);
  }
  for (const y of [Number(today.slice(0, 4)), Number(until.slice(0, 4))].filter((v, i, a) => a.indexOf(v) === i)) {
    for (const f of TAX_FIXED) push(`fixed:${y}-${f.md}`, `${y}-${f.md}`, f.title, f.detail, null, "/hr/tax");
  }
  // 날짜 순. 같은 날은 넣은 순서(원천세 → 4대보험 → 날짜가 정해진 일정) — sort 는 순서를 지킨다
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── 해야 할 일 ──────────────────────────────────────────────────────
export type Todo = { key: string; level: "now" | "soon"; text: string; sub: string; href: string; due: string | null };
export type TodoFacts = {
  today: string; workplaces: HomeWorkplace[]; employees: HomeEmployee[];
  payrolls: HomePayroll[];                    // 최근 여섯 달의 급여 머리
  loggedLastMonth: ReadonlySet<string>;       // 지난달 근무대장에 줄이 있는 직원 id
  expiring: { id: string; days: number }[];   // 30일 안에 소멸하는 연차가 남은 직원
  rate: { exists: boolean; checked: boolean; min_wage: number };
  taxTable: boolean;                          // 오늘 쓸 간이세액표가 있는가
  closing?: { ready: boolean; closed: ReadonlySet<string> };   // 지난달 근무대장 확정(hr/010): ready = 확정 기능이 있는가, closed = 확정한 사업장
};
export const SOON_DAYS = 7;          // 이 안이면 '지금'
export const CONTRACT_AHEAD = 30;    // 계약 종료를 며칠 앞부터 알리나
export const LEAVE_AHEAD = 30;       // 연차 소멸을 며칠 앞부터 알리나
export const SEVERANCE_DAYS = 14;    // 퇴직금 지급 기한(퇴직한 날부터)

export function buildTodos(f: TodoFacts): Todo[] {
  const { today } = f;
  const out: Todo[] = [];
  const multi = f.workplaces.length > 1;
  const at = (wp: HomeWorkplace) => (multi ? `${wp.name} · ` : "");
  const level = (due: string | null): Todo["level"] => (due !== null && diffDays(today, due) <= SOON_DAYS ? "now" : "soon");
  const empName = new Map(f.employees.map((e) => [e.id, e.name]));

  // 1) 지난달 급여 — 저장 전·확정 전, 그리고 시급제 직원의 빈 근무대장
  const last = shiftMonth(today.slice(0, 7), -1);
  const range = monthRange(last);
  for (const wp of f.workplaces.filter((w) => w.active)) {
    const staff = f.employees.filter((e) => e.workplace_id === wp.id && e.hire_date <= range.to && (!e.leave_date || e.leave_date >= range.from));
    if (staff.length === 0) continue;
    const p = f.payrolls.find((x) => x.workplace_id === wp.id && x.month === last);
    const payDate = p?.pay_date || defaultPayDate(last, wp.payday);
    const href = `/hr/pay?month=${last}&workplace=${wp.id}`;
    // 근무대장을 확정해야 급여를 저장할 수 있다 — 확정 전이면 급여 줄 대신 확정 줄을 띄운다
    const needClose = !!f.closing?.ready && !f.closing.closed.has(wp.id) && p?.status !== "confirmed";
    if (needClose) out.push({ key: `work-close:${wp.id}`, level: level(payDate), text: `${monthNo(last)} 근무대장 확정 전`, sub: `${at(wp)}급여 지급일 ${mdText(payDate)} · ${ddayText(today, payDate)}`, href: `/hr/work?month=${last}`, due: payDate });
    else if (!p) out.push({ key: `pay-none:${wp.id}`, level: level(payDate), text: `${monthNo(last)} 급여 저장 전`, sub: `${at(wp)}지급일 ${mdText(payDate)} · ${ddayText(today, payDate)}`, href, due: payDate });
    else if (p.status !== "confirmed") out.push({ key: `pay-draft:${wp.id}:${last}`, level: level(payDate), text: `${monthNo(last)} 급여 확정 전`, sub: `${at(wp)}지급일 ${mdText(payDate)} · ${ddayText(today, payDate)}`, href, due: payDate });
    if (!p || p.status !== "confirmed") {
      const empty = staff.filter((e) => e.pay_type === "hourly" && !f.loggedLastMonth.has(e.id));
      if (empty.length > 0) out.push({ key: `work-empty:${wp.id}`, level: level(payDate), text: `${monthNo(last)} 근무대장이 빈 시급제 직원 ${empty.length}명`, sub: `${at(wp)}${namesText(empty.map((e) => e.name))}`, href: `/hr/work?month=${last}`, due: payDate });
    }
  }
  // 더 앞 달에 확정하지 않고 남은 급여
  for (const p of f.payrolls.filter((x) => x.month < last && x.status !== "confirmed")) {
    const wp = f.workplaces.find((w) => w.id === p.workplace_id);
    if (!wp) continue;
    out.push({ key: `pay-draft:${wp.id}:${p.month}`, level: "now", text: `${monthNo(p.month)} 급여 확정 전`, sub: `${at(wp)}지급일 ${mdText(p.pay_date)} · ${ddayText(today, p.pay_date)}`, href: `/hr/pay?month=${p.month}&workplace=${wp.id}`, due: p.pay_date });
  }

  // 2) 퇴직금 — 1년 이상 일하고 그만두는 직원(마지막 근무일이 14일 전 ~ 30일 뒤)
  for (const e of f.employees) {
    if (!e.leave_date || e.leave_date < addDays(today, -SEVERANCE_DAYS) || e.leave_date > addDays(today, 30)) continue;
    if (diffDays(e.hire_date, e.leave_date) + 1 < 365) continue;
    const due = addDays(e.leave_date, SEVERANCE_DAYS);
    out.push({ key: `severance:${e.id}`, level: level(due), text: `${e.name} 퇴직금 지급`, sub: `마지막 근무일 ${mdText(e.leave_date)} · 기한 ${mdText(due)} · ${ddayText(today, due)}`, href: "/hr/severance", due });
  }

  // 3) 계약 종료가 다가오는 직원
  for (const e of f.employees) {
    if (!e.contract_end || e.leave_date || e.contract_end < today || e.contract_end > addDays(today, CONTRACT_AHEAD)) continue;
    out.push({ key: `contract:${e.id}`, level: level(e.contract_end), text: `${e.name} 계약 종료`, sub: `${mdText(e.contract_end)} · ${ddayText(today, e.contract_end)}`, href: `/hr/employees/${e.id}`, due: e.contract_end });
  }

  // 4) 곧 소멸하는 연차
  const exp = f.expiring.filter((x) => x.days > 0 && empName.has(x.id));
  if (exp.length > 0) {
    out.push({ key: "leave-expiring", level: "soon", text: `${LEAVE_AHEAD}일 안에 소멸하는 연차 ${exp.length}명`, sub: namesText(exp.map((x) => `${empName.get(x.id)} ${Math.round(x.days * 100) / 100}일`)), href: "/hr/leave", due: null });
  }

  // 5) 요율·간이세액표
  if (!f.rate.exists) out.push({ key: "rate-none", level: "now", text: "요율이 없습니다", sub: "4대보험 요율·최저임금", href: "/hr/rates", due: null });
  else if (!f.rate.checked) out.push({ key: "rate-unchecked", level: "soon", text: "요율 확인 전", sub: "4대보험 요율·최저임금", href: "/hr/rates", due: null });
  if (!f.taxTable) out.push({ key: "taxtable-none", level: "now", text: "간이세액표가 없습니다", sub: "소득세를 계산하지 못합니다", href: "/hr/rates", due: null });

  // 6) 최저임금보다 낮은 시급
  if (f.rate.exists && f.rate.min_wage > 0) {
    const low = f.employees.filter((e) => activeOn(e, today) && e.pay_type === "hourly" && e.hourly_wage > 0 && e.hourly_wage < f.rate.min_wage);
    if (low.length > 0) out.push({ key: "min-wage", level: "now", text: `최저임금보다 낮은 시급 ${low.length}명`, sub: `${namesText(low.map((e) => e.name))} · 최저임금 ${numText(f.rate.min_wage)}원`, href: "/hr/employees", due: null });
  }

  const rank = (t: Todo) => (t.level === "now" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.due || "9999").localeCompare(b.due || "9999") || a.key.localeCompare(b.key));
}

// ── 묶음 ────────────────────────────────────────────────────────────
// 구역마다 따로 불러와, 한 구역이 실패해도(DB 준비 전 등) 나머지는 보인다. 실패한 구역은 null 이고 errors 에 문장이 있다.
export type HomeBundle = {
  today: string;
  status: TodayStatus | null; tax: TaxEvent[] | null; todos: Todo[] | null;
  errors: { status?: string; tax?: string; todos?: string };
};
