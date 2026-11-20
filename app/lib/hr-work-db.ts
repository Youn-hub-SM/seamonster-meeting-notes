// 근무대장 — 서버 전용 조회. 화면에서 import 하지 말 것.

import { hrDb } from "./hr-db";
import { addDays, monthRange, type RosterEmployee, type RosterLog, type RosterWorkplace, type WorkKind } from "./hr-work";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

const EMP_COLS = "id,workplace_id,emp_no,name,dept,position,pay_type,hire_date,leave_date,work_days,work_start,work_end,break_min,daily_hours";
const WP_COLS = "id,name,five_plus,week_start,weekly_pay_month,auto_weekly";
const LOG_COLS = "employee_id,work_date,kind,start_time,end_time,break_min,hours,night_hours,leave_days,memo";

export function toRosterEmployee(r: Row): RosterEmployee {
  return {
    id: String(r.id), workplace_id: String(r.workplace_id), emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""),
    dept: String(r.dept ?? ""), position: String(r.position ?? ""), pay_type: r.pay_type === "monthly" ? "monthly" : "hourly",
    hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
    work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [],
    work_start: String(r.work_start ?? ""), work_end: String(r.work_end ?? ""), break_min: num(r.break_min), daily_hours: num(r.daily_hours),
  };
}
function toRosterLog(r: Row): RosterLog {
  return {
    employee_id: String(r.employee_id), work_date: String(r.work_date), kind: String(r.kind) as WorkKind,
    start_time: (r.start_time as string) || null, end_time: (r.end_time as string) || null, break_min: num(r.break_min),
    hours: num(r.hours), night_hours: num(r.night_hours), leave_days: num(r.leave_days), memo: String(r.memo ?? ""),
  };
}

export async function fetchWorkplaces(): Promise<RosterWorkplace[]> {
  const { data, error } = await hrDb().from("workplaces").select(WP_COLS).order("sort").order("created_at");
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map((r) => ({
    id: String(r.id), name: String(r.name), five_plus: !!r.five_plus, week_start: num(r.week_start) || 1,
    weekly_pay_month: r.weekly_pay_month === "start" ? "start" : "end", auto_weekly: !!r.auto_weekly,
  }));
}

// 그 달에 하루라도 재직한 직원(employeeId 를 주면 그 한 명 — 재직 여부와 상관없이)
export async function fetchRoster(month: string, employeeId?: string): Promise<RosterEmployee[]> {
  const { from, to } = monthRange(month);
  let q = hrDb().from("employees").select(EMP_COLS).order("hire_date").order("name");
  if (employeeId) q = q.eq("id", employeeId);
  else q = q.lte("hire_date", to).or(`leave_date.is.null,leave_date.gte.${from}`);
  const { data, error } = await q;
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map(toRosterEmployee);
}

// 그 달과 겹치는 주를 모두 덮게 앞뒤 6일을 더 읽는다(주의 첫 요일이 사업장마다 달라도 충분하다).
//  PostgREST 는 한 번에 1000줄까지만 주므로 끝까지 이어 읽는다 — 중간에 끊긴 채 계산하면 급여가 틀린다.
export async function fetchLogs(month: string, employeeIds: string[]): Promise<RosterLog[]> {
  if (employeeIds.length === 0) return [];
  const { from, to } = monthRange(month);
  const lo = addDays(from, -6), hi = addDays(to, 6);
  const out: RosterLog[] = [];
  const PAGE = 1000;
  for (let i = 0; i < employeeIds.length; i += 100) {
    const ids = employeeIds.slice(i, i + 100);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await hrDb().from("work_logs").select(LOG_COLS)
        .in("employee_id", ids).gte("work_date", lo).lte("work_date", hi)
        .order("employee_id").order("work_date").range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data || []) as unknown as Row[];
      out.push(...rows.map(toRosterLog));
      if (rows.length < PAGE) break;
    }
  }
  return out;
}
