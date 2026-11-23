// 통계 — 서버 전용 조회. 화면에서 import 하지 말 것. 읽기만 한다(저장하는 것이 없다).

import { hrDb, isHrPending } from "./hr-db";
import { isActiveOn, todayKst } from "./hr";
import { addDays, isMonth, monthRange, type RosterLog, type WorkKind, type WorkPlace } from "./hr-work";
import { fetchWorkplaces } from "./hr-work-db";
import { fetchGrants, fetchLeaveLogs } from "./hr-leave-db";
import { costByAffiliation, costStats, hoursStats, leaveStats, monthsEnding, peopleStats, type CostLine, type CostPayroll, type StatsBundle, type StatsEmployee } from "./hr-stats";
import { missingAffiliation, type DbResult } from "./hr-employees";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const PAGE = 1000;
const UUID = /^[0-9a-f-]{36}$/i;

// 기간과 하루라도 겹치게 재직한 직원(사업장을 주면 그 사업장만)
async function fetchEmployees(from: string, to: string, workplaceId: string): Promise<StatsEmployee[]> {
  const COLS = "id,workplace_id,emp_no,name,emp_type,pay_type,hire_date,leave_date,work_days,daily_hours";
  const run = (cols: string) => {
    const q = hrDb().from("employees").select(cols)
      .lte("hire_date", to).or(`leave_date.is.null,leave_date.gte.${from}`).order("hire_date").order("name").limit(5000);
    return workplaceId ? q.eq("workplace_id", workplaceId) : q;
  };
  // 소속 칸(hr/006)이 아직 없는 DB 에서는 그 칸 없이 다시 읽는다(소속별 통계는 나오지 않는다)
  let res: DbResult = await run(`${COLS},affiliation`);
  if (res.error && missingAffiliation(res.error)) res = await run(COLS);
  if (res.error) throw res.error;
  return ((res.data || []) as unknown as Row[]).map((r) => ({
    id: String(r.id), workplace_id: String(r.workplace_id), emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""),
    affiliation: String(r.affiliation ?? ""),
    emp_type: String(r.emp_type ?? ""), pay_type: r.pay_type === "monthly" ? "monthly" : "hourly",
    hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
    work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [], daily_hours: num(r.daily_hours),
  }));
}

// 기간의 근무대장 줄 전부. PostgREST 는 한 번에 1000줄까지만 주므로 끝까지 이어 읽는다 — 중간에 끊긴 채 더하면 통계가 틀린다.
async function fetchLogsRange(employeeIds: string[], from: string, to: string): Promise<RosterLog[]> {
  const out: RosterLog[] = [];
  for (let i = 0; i < employeeIds.length; i += 100) {
    const ids = employeeIds.slice(i, i + 100);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await hrDb().from("work_logs").select("employee_id,work_date,kind,start_time,end_time,break_min,hours,night_hours,leave_days,memo")
        .in("employee_id", ids).gte("work_date", from).lte("work_date", to).order("employee_id").order("work_date").range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data || []) as unknown as Row[];
      for (const r of rows) {
        out.push({
          employee_id: String(r.employee_id), work_date: String(r.work_date), kind: String(r.kind) as WorkKind,
          start_time: (r.start_time as string) || null, end_time: (r.end_time as string) || null, break_min: num(r.break_min),
          hours: num(r.hours), night_hours: num(r.night_hours), leave_days: num(r.leave_days), memo: "",
        });
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

// 기간의 월 급여 머리와 줄(금액과 항목만). 급여 표가 없으면 null(hr/003 미적용).
async function fetchCost(months: string[], workplaceId: string): Promise<{ payrolls: CostPayroll[]; lines: CostLine[] } | null> {
  try {
    let q = hrDb().from("payrolls").select("id,month,status").in("month", months).limit(2000);
    if (workplaceId) q = q.eq("workplace_id", workplaceId);
    const p = await q;
    if (p.error) throw p.error;
    const payrolls: CostPayroll[] = ((p.data || []) as unknown as Row[]).map((r) => ({ id: String(r.id), month: String(r.month), status: r.status === "confirmed" ? "confirmed" : "draft" }));
    const lines: CostLine[] = [];
    const ids = payrolls.map((x) => x.id);
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      for (let offset = 0; ; offset += PAGE) {
        const l = await hrDb().from("payroll_lines").select("payroll_id,employee_id,pay_total,deduct_total,net_pay,employer:result->employer,items:result->items")
          .in("payroll_id", part).order("payroll_id").order("employee_id").range(offset, offset + PAGE - 1);
        if (l.error) throw l.error;
        const rows = (l.data || []) as unknown as Row[];
        for (const r of rows) {
          const items = Array.isArray(r.items) ? (r.items as { code?: unknown; kind?: unknown; amount?: unknown }[]) : [];
          lines.push({
            payroll_id: String(r.payroll_id), employee_id: String(r.employee_id ?? ""), pay_total: num(r.pay_total), deduct_total: num(r.deduct_total), net_pay: num(r.net_pay),
            employer_total: num((r.employer as { total?: unknown } | null)?.total),
            items: items.map((i) => ({ code: String(i.code ?? ""), kind: String(i.kind ?? ""), amount: num(i.amount) })),
          });
        }
        if (rows.length < PAGE) break;
      }
    }
    return { payrolls, lines };
  } catch (err) {
    if (isHrPending(err)) return null;
    throw err;
  }
}

// wantAffiliation = 소속 하나로 좁혀 본다("" = 모든 소속). 소속은 지금 인사대장의 값으로 가른다.
export async function loadStats(end: string, wantWorkplace: string, wantAffiliation = ""): Promise<StatsBundle | { error: string; status: number }> {
  if (!isMonth(end)) return { error: "달을 고르세요.", status: 400 };
  const today = todayKst();
  const months = monthsEnding(end, 12);
  const from = monthRange(months[0]).from, to = monthRange(end).to;
  const workplaces = await fetchWorkplaces();
  const workplaceId = UUID.test(wantWorkplace) && workplaces.some((w) => w.id === wantWorkplace) ? wantWorkplace : "";
  const everyone = await fetchEmployees(from, to, workplaceId);
  const affiliations = [...new Set(everyone.map((e) => e.affiliation).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const affiliation = affiliations.includes(wantAffiliation) ? wantAffiliation : "";
  const employees = affiliation ? everyone.filter((e) => e.affiliation === affiliation) : everyone;
  const ids = employees.map((e) => e.id);
  const wpOf = new Map<string, WorkPlace>(workplaces.map((w) => [w.id, w]));

  // 주휴·연장은 주 단위라 앞뒤 6일을 더 읽는다(근무대장 화면과 같다)
  const [logs, costAll] = await Promise.all([fetchLogsRange(ids, addDays(from, -6), addDays(to, 6)), fetchCost(months, workplaceId)]);
  // 소속 하나를 골랐으면 그 소속 직원의 급여 줄만 더한다
  const idSet = new Set(ids);
  const cost = costAll && affiliation ? { payrolls: costAll.payrolls, lines: costAll.lines.filter((l) => idSet.has(l.employee_id)) } : costAll;
  const costByAff = costAll && !affiliation && affiliations.length > 0
    ? costByAffiliation(costAll.payrolls, costAll.lines, months, new Map(everyone.map((e) => [e.id, e.affiliation]))) : null;

  // 연차는 오늘 기준 — 재직자만. 연차 표가 없으면 null(hr/004 미적용)
  let leave: StatsBundle["leave"] = null;
  try {
    const activeIds = employees.filter((e) => isActiveOn(e, today)).map((e) => e.id);
    const [grants, leaveLogs] = await Promise.all([fetchGrants(activeIds), fetchLeaveLogs(activeIds, addDays(today, -1100))]);
    leave = leaveStats(employees, grants, leaveLogs.uses, today);
  } catch (err) {
    if (!isHrPending(err)) throw err;
  }

  return {
    end, months, today, workplace_id: workplaceId, workplaces: workplaces.map((w) => ({ id: w.id, name: w.name })),
    affiliation, affiliations, costByAff,
    cost: cost ? costStats(cost.payrolls, cost.lines, months) : null,
    hours: hoursStats(employees, wpOf, logs, months),
    people: peopleStats(employees, months, today),
    leave,
  };
}
