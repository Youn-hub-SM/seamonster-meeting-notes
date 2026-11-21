// 연차 — 서버 전용 조회·자동 발생. 화면에서 import 하지 말 것.

import { hrDb } from "./hr-db";
import { addDays, type WorkKind, type WorkLog } from "./hr-work";
import { compareBases, expectedGrants, type LeaveEmployee, type LeaveGrant, type LeaveUse, type LeaveWorkplace } from "./hr-leave";

export const HR_PENDING_004 = "DB 준비 전입니다. supabase/migrations/hr/004_leave.sql 을 적용하세요.";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const PAGE = 1000;

const EMP_COLS = "id,workplace_id,emp_no,name,dept,position,hire_date,leave_date,work_days,daily_hours,leave_basis";
export const GRANT_COLS = "id,employee_id,grant_date,expire_date,days,kind,auto_key,reason,voided,created_by,created_at";
const LOG_COLS = "employee_id,work_date,kind,start_time,end_time,break_min,hours,night_hours,leave_days,memo";

export function toGrant(r: Row): LeaveGrant {
  return {
    id: String(r.id), employee_id: String(r.employee_id), grant_date: String(r.grant_date), expire_date: (r.expire_date as string) || null,
    days: num(r.days), kind: r.kind === "monthly" || r.kind === "annual" ? r.kind : "manual", auto_key: (r.auto_key as string) || null,
    reason: String(r.reason ?? ""), voided: !!r.voided, created_by: String(r.created_by ?? ""), created_at: String(r.created_at ?? ""),
  };
}
const toEmployee = (r: Row): LeaveEmployee => ({
  id: String(r.id), workplace_id: String(r.workplace_id), emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""),
  dept: String(r.dept ?? ""), position: String(r.position ?? ""), hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
  work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [], daily_hours: num(r.daily_hours),
  leave_basis: r.leave_basis === "hire" || r.leave_basis === "fiscal" ? r.leave_basis : "",
});

export async function fetchLeaveWorkplaces(): Promise<LeaveWorkplace[]> {
  const { data, error } = await hrDb().from("workplaces").select("id,name,five_plus,fiscal_start,leave_basis,leave_round").order("sort").order("created_at");
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map((r) => ({
    id: String(r.id), name: String(r.name ?? ""), five_plus: !!r.five_plus, fiscal_start: String(r.fiscal_start || "01-01"),
    leave_basis: r.leave_basis === "hire" ? "hire" : "fiscal",
    leave_round: (["ceil_half", "ceil_one", "round_half", "none"].includes(String(r.leave_round)) ? r.leave_round : "ceil_half") as LeaveWorkplace["leave_round"],
  }));
}

// 재직자와 최근 1년 안에 퇴사한 직원(employeeId 를 주면 그 한 명)
export async function fetchLeaveEmployees(today: string, employeeId?: string): Promise<LeaveEmployee[]> {
  let q = hrDb().from("employees").select(EMP_COLS).order("emp_no").order("hire_date").order("name");
  if (employeeId) q = q.eq("id", employeeId);
  else q = q.or(`leave_date.is.null,leave_date.gte.${addDays(today, -365)}`);
  const { data, error } = await q;
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map(toEmployee);
}

export async function fetchGrants(employeeIds: string[]): Promise<LeaveGrant[]> {
  const out: LeaveGrant[] = [];
  for (let i = 0; i < employeeIds.length; i += 100) {
    const ids = employeeIds.slice(i, i + 100);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await hrDb().from("leave_grants").select(GRANT_COLS).in("employee_id", ids).order("employee_id").order("grant_date").order("id").range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data || []) as unknown as Row[];
      out.push(...rows.map(toGrant));
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

// 근무대장에서 연차 사용(leave_days > 0)과 결근을 읽는다(since 부터). 끝까지 이어 읽는다.
export async function fetchLeaveLogs(employeeIds: string[], since: string): Promise<{ uses: LeaveUse[]; absences: Map<string, Set<string>> }> {
  const uses: LeaveUse[] = [];
  const absences = new Map<string, Set<string>>();
  for (let i = 0; i < employeeIds.length; i += 100) {
    const ids = employeeIds.slice(i, i + 100);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await hrDb().from("work_logs").select("employee_id,work_date,kind,leave_days")
        .in("employee_id", ids).gte("work_date", since).or("leave_days.gt.0,kind.eq.absent")
        .order("employee_id").order("work_date").range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data || []) as unknown as Row[];
      for (const r of rows) {
        const id = String(r.employee_id), d = String(r.work_date);
        if (num(r.leave_days) > 0) uses.push({ employee_id: id, work_date: d, days: num(r.leave_days), kind: String(r.kind) });
        if (r.kind === "absent") { if (!absences.has(id)) absences.set(id, new Set()); absences.get(id)!.add(d); }
      }
      if (rows.length < PAGE) break;
    }
  }
  return { uses, absences };
}

// 한 직원의 기간 안 근무대장 줄(사용 등록·취소가 그 줄을 고친다)
export async function fetchLogsBetween(employeeId: string, from: string, to: string): Promise<Map<string, WorkLog>> {
  const { data, error } = await hrDb().from("work_logs").select(LOG_COLS).eq("employee_id", employeeId).gte("work_date", from).lte("work_date", to).order("work_date").limit(400);
  if (error) throw error;
  const out = new Map<string, WorkLog>();
  for (const r of (data || []) as unknown as Row[]) {
    out.set(String(r.work_date), {
      work_date: String(r.work_date), kind: String(r.kind) as WorkKind, start_time: (r.start_time as string) || null, end_time: (r.end_time as string) || null,
      break_min: num(r.break_min), hours: num(r.hours), night_hours: num(r.night_hours), leave_days: num(r.leave_days), memo: String(r.memo ?? ""),
    });
  }
  return out;
}

// 오늘까지 생겼어야 할 자동 발생 건 가운데 아직 없는 것을 넣는다. 반환 = 이번에 넣은 건.
//  같은 건은 (employee_id, auto_key) 유일 제약으로 한 번만 생긴다 — 두 창이 동시에 열어도 겹치지 않는다.
export async function ensureAutoGrants(
  employees: LeaveEmployee[], workplaces: LeaveWorkplace[], grants: LeaveGrant[], absences: Map<string, Set<string>>, today: string, actor: string,
): Promise<LeaveGrant[]> {
  const wpOf = new Map(workplaces.map((w) => [w.id, w]));
  const have = new Set(grants.filter((g) => g.auto_key).map((g) => `${g.employee_id}|${g.auto_key}`));
  const rows: Row[] = [];
  const none = new Set<string>();
  for (const e of employees) {
    const wp = wpOf.get(e.workplace_id);
    if (!wp) continue;
    for (const g of expectedGrants(e, wp, absences.get(e.id) || none, today)) {
      if (have.has(`${e.id}|${g.auto_key}`) || g.days <= 0) continue;
      rows.push({ employee_id: e.id, grant_date: g.grant_date, expire_date: g.expire_date, days: g.days, kind: g.kind, auto_key: g.auto_key, reason: g.reason, created_by: `자동(${actor})`, updated_by: actor });
    }
  }
  if (rows.length === 0) return [];
  const out: LeaveGrant[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await hrDb().from("leave_grants").upsert(rows.slice(i, i + 500), { onConflict: "employee_id,auto_key", ignoreDuplicates: true }).select(GRANT_COLS);
    if (error) throw error;
    out.push(...((data || []) as unknown as Row[]).map(toGrant));
  }
  return out;
}

// 퇴사한 직원의 두 기준 비교(회계연도 기준이 입사일 기준보다 적으면 그 차이)
export function leaverCompare(employees: LeaveEmployee[], workplaces: LeaveWorkplace[], absences: Map<string, Set<string>>, today: string): Record<string, { hire: number; fiscal: number; short: number }> {
  const wpOf = new Map(workplaces.map((w) => [w.id, w]));
  const out: Record<string, { hire: number; fiscal: number; short: number }> = {};
  const none = new Set<string>();
  for (const e of employees) {
    const wp = wpOf.get(e.workplace_id);
    if (!e.leave_date || !wp || !wp.five_plus) continue;
    out[e.id] = compareBases(e, wp, absences.get(e.id) || none, today);
  }
  return out;
}
