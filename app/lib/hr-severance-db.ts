// 퇴직금 — 서버 전용 조회. 화면에서 import 하지 말 것. 읽기만 한다(저장하는 것이 없다).

import { hrDb } from "./hr-db";
import { isDate, wageOn } from "./hr";
import { wagesOf } from "./hr-employees";
import { monthRange, weeklyHolidayHours } from "./hr-work";
import { dayCount, ordinaryDaily, yearMonths, type SevBundle, type SevEmployee, type SevMonth, type SevPick } from "./hr-severance";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const EMP_COLS = "id,workplace_id,emp_no,name,dept,position,birth_date,hire_date,leave_date,pay_type,daily_hours,work_days";

// 고를 직원 전부(퇴사자 포함). 퇴사한 직원이 먼저, 그 안에서는 최근에 퇴사한 순.
export async function severanceEmployees(): Promise<SevPick[]> {
  const [emps, wps] = await Promise.all([
    hrDb().from("employees").select("id,workplace_id,emp_no,name,dept,position,birth_date,hire_date,leave_date").order("name").limit(5000),
    hrDb().from("workplaces").select("id,name").limit(200),
  ]);
  if (emps.error) throw emps.error;
  if (wps.error) throw wps.error;
  const wpName = new Map(((wps.data || []) as unknown as Row[]).map((w) => [String(w.id), String(w.name ?? "")]));
  const list: SevPick[] = ((emps.data || []) as unknown as Row[]).map((r) => ({
    id: String(r.id), workplace: wpName.get(String(r.workplace_id)) || "", emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""),
    dept: String(r.dept ?? ""), position: String(r.position ?? ""), birth_date: (r.birth_date as string) || null,
    hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
  }));
  return list.sort((a, b) => (b.leave_date || "").localeCompare(a.leave_date || "") || a.name.localeCompare(b.name, "ko"));
}

// 한 직원의 퇴직금 계산 자료. lastDay 를 주지 않으면 인사대장의 퇴사일, 그것도 없으면 today.
export async function loadSeverance(employeeId: string, wantLastDay: string, today: string): Promise<SevBundle | { error: string; status: number }> {
  const { data, error } = await hrDb().from("employees").select(EMP_COLS).eq("id", employeeId).maybeSingle();
  if (error) throw error;
  if (!data) return { error: "없는 직원입니다.", status: 404 };
  const r = data as unknown as Row;
  const wp = await hrDb().from("workplaces").select("id,name").eq("id", String(r.workplace_id)).maybeSingle();
  if (wp.error) throw wp.error;
  const employee: SevEmployee = {
    id: String(r.id), workplace_id: String(r.workplace_id), workplace: String((wp.data as Row | null)?.name ?? ""),
    emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""), dept: String(r.dept ?? ""), position: String(r.position ?? ""),
    birth_date: (r.birth_date as string) || null, hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
    pay_type: r.pay_type === "monthly" ? "monthly" : "hourly", daily_hours: num(r.daily_hours),
    work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [],
  };
  const lastDay = isDate(wantLastDay) ? wantLastDay : employee.leave_date || today;
  if (lastDay < employee.hire_date) return { error: "마지막 근무일이 입사일보다 앞입니다.", status: 400 };

  // 퇴직 전 1년에 걸치는 달의 급여(이 직원의 줄만)
  const months = yearMonths(lastDay);
  const heads = await hrDb().from("payrolls").select("id,month,status").eq("workplace_id", employee.workplace_id).in("month", months).limit(100);
  if (heads.error) throw heads.error;
  const headOf = new Map(((heads.data || []) as unknown as Row[]).map((h) => [String(h.id), h]));
  const lineOf = new Map<string, Row>();
  if (headOf.size > 0) {
    const lines = await hrDb().from("payroll_lines").select("payroll_id,pay_total,items:result->items").in("payroll_id", [...headOf.keys()]).eq("employee_id", employee.id).limit(100);
    if (lines.error) throw lines.error;
    for (const l of (lines.data || []) as unknown as Row[]) lineOf.set(String(headOf.get(String(l.payroll_id))?.month), { ...l, status: headOf.get(String(l.payroll_id))?.status });
  }
  const out: SevMonth[] = months.map((month) => {
    const range = monthRange(month);
    const from = range.from > employee.hire_date ? range.from : employee.hire_date, to = range.to < lastDay ? range.to : lastDay;
    const employed = from <= to ? { from, to, days: dayCount(from, to) } : null;
    const l = lineOf.get(month);
    if (!l) return { month, status: "none", pay_total: 0, items: [], employed };
    const items = (Array.isArray(l.items) ? (l.items as { code?: unknown; name?: unknown; kind?: unknown; amount?: unknown }[]) : [])
      .filter((i) => i.kind === "pay" && num(i.amount) !== 0).map((i) => ({ code: String(i.code ?? ""), name: String(i.name ?? ""), amount: num(i.amount) }));
    return { month, status: l.status === "confirmed" ? "confirmed" : "draft", pay_total: num(l.pay_total), items, employed };
  });

  const wages = (await wagesOf([employee.id])).get(employee.id) || [];
  return {
    employee, last_day: lastDay, months: out,
    ordinary: ordinaryDaily(employee, wageOn(wages, lastDay), weeklyHolidayHours(employee)),
    weekly_hours: Math.round(employee.daily_hours * employee.work_days.length * 100) / 100,
  };
}
