// 첫 화면(대시보드) — 서버 전용 조회. 화면에서 import 하지 말 것. 읽기만 한다(연차 자동 발생도 여기서는 넣지 않는다).
//  직원·사업장은 한 번 읽어 세 구역이 같이 쓰고, 구역마다 따로 불러와 한 구역이 실패해도 나머지는 보이게 한다.

import { hrDb, isHrPending } from "./hr-db";
import { rateOn, wageOn } from "./hr";
import { missingAffiliation, wagesOf } from "./hr-employees";
import { addDays, monthRange, shiftMonth } from "./hr-work";
import { fetchHolidays } from "./hr-holidays-db";
import { fetchGrants, fetchLeaveLogs } from "./hr-leave-db";
import { summarizeLeave } from "./hr-leave";
import { fetchRates, fetchTaxTable } from "./hr-pay-db";
import { loadTax } from "./hr-tax-db";
import { fetchClosings } from "./hr-punch-db";
import type { TaxRow } from "./hr-tax";
import {
  LEAVE_AHEAD, TAX_HORIZON, buildTodos, taxSchedule, todayStatus,
  type HomeBundle, type HomeEmployee, type HomeLog, type HomePayroll, type HomeWorkplace,
} from "./hr-home";

type Row = Record<string, unknown>;
type Res = { data: unknown; error: { message?: string; code?: string } | null };
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const PAGE = 1000;
const EMP_COLS = "id,workplace_id,name,pay_type,hire_date,leave_date,contract_end,work_days,daily_hours";
const LEAVE_SINCE = 1100;   // 연차 사용을 읽는 범위(연차 화면과 같다)

// PostgREST 는 한 번에 1000줄까지만 준다 — 끝까지 이어 읽는다
async function readAll(run: (from: number, to: number) => PromiseLike<Res>): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await run(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data || []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function fetchWorkplaces(): Promise<HomeWorkplace[]> {
  const { data, error } = await hrDb().from("workplaces").select("id,name,payday,active,five_plus").order("sort").order("created_at");
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map((r) => ({ id: String(r.id), name: String(r.name ?? ""), payday: num(r.payday) || 10, active: r.active !== false, five_plus: !!r.five_plus }));
}

// 재직자와 최근 70일 안에 퇴사한 직원(지난달 급여·퇴직금 기한에 걸리는 범위). 시급은 오늘 유효한 임금 줄에서.
async function fetchEmployees(today: string): Promise<HomeEmployee[]> {
  const run = (cols: string): PromiseLike<Res> => hrDb().from("employees").select(cols)
    .or(`leave_date.is.null,leave_date.gte.${addDays(today, -70)}`).order("hire_date").order("name").limit(5000);
  let res = await run(`${EMP_COLS},affiliation`);
  if (res.error && missingAffiliation(res.error)) res = await run(EMP_COLS);   // 소속 칸(hr/006) 전
  if (res.error) throw res.error;
  const rows = (res.data || []) as Row[];
  const wages = await wagesOf(rows.filter((r) => r.pay_type !== "monthly").map((r) => String(r.id)));
  return rows.map((r) => {
    const hourly = r.pay_type !== "monthly";
    return {
      id: String(r.id), workplace_id: String(r.workplace_id), name: String(r.name ?? ""), affiliation: String(r.affiliation ?? ""),
      pay_type: hourly ? "hourly" : "monthly", hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
      contract_end: (r.contract_end as string) || null,
      work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [], daily_hours: num(r.daily_hours),
      hourly_wage: hourly ? num(wageOn(wages.get(String(r.id)) || [], today)?.hourly_wage) : 0,
    };
  });
}

const toLog = (r: Row): HomeLog => ({ employee_id: String(r.employee_id), work_date: String(r.work_date), kind: String(r.kind ?? ""), hours: num(r.hours), leave_days: num(r.leave_days) });

async function loadStatus(today: string, workplaces: HomeWorkplace[], employees: HomeEmployee[]) {
  const [logs, hol] = await Promise.all([
    readAll((a, b) => hrDb().from("work_logs").select("employee_id,work_date,kind,hours,leave_days")
      .gte("work_date", today).lte("work_date", addDays(today, 7)).order("work_date").order("employee_id").range(a, b)),
    fetchHolidays(today, today),
  ]);
  return todayStatus({ today, workplaces, employees, logs: logs.map(toLog), holidays: hol.list });
}

async function loadTaxEvents(today: string) {
  const until = addDays(today, TAX_HORIZON);
  // 원천세는 '지급한 달' 기준 — 지난달부터 기한 범위의 앞 달까지 지급한 급여가 든 해를 읽는다
  const years = new Set<number>();
  for (let m = shiftMonth(today.slice(0, 7), -2); m <= until.slice(0, 7); m = shiftMonth(m, 1)) years.add(Number(m.slice(0, 4)));
  const [bundles, hol] = await Promise.all([Promise.all([...years].map((y) => loadTax(y))), fetchHolidays(addDays(today, -7), addDays(until, 10))]);
  const rows: TaxRow[] = bundles.flatMap((b) => b.rows);
  // 기한을 미루는 날 = 모두에게 걸리는 공휴일(사업장·소속에만 걸리는 휴무일은 세무 기한과 상관없다)
  const holidays = new Set(hol.list.filter((h) => h.kind === "public" && !h.workplace_id).map((h) => h.date));
  return taxSchedule({ today, rows, holidays });
}

async function loadTodos(today: string, workplaces: HomeWorkplace[], employees: HomeEmployee[]) {
  const last = shiftMonth(today.slice(0, 7), -1);
  const range = monthRange(last);
  const hourlyIds = employees.filter((e) => e.pay_type === "hourly").map((e) => e.id);
  const activeIds = employees.filter((e) => e.hire_date <= today && (!e.leave_date || e.leave_date >= today)).map((e) => e.id);

  const payrollsP = hrDb().from("payrolls").select("workplace_id,month,pay_date,status").gte("month", shiftMonth(last, -5)).order("month").limit(2000);
  const loggedP = (async () => {
    const seen = new Set<string>();
    for (let i = 0; i < hourlyIds.length; i += 100) {
      const ids = hourlyIds.slice(i, i + 100);
      const rows = await readAll((a, b) => hrDb().from("work_logs").select("employee_id,work_date")
        .in("employee_id", ids).gte("work_date", range.from).lte("work_date", range.to).order("employee_id").order("work_date").range(a, b));
      for (const r of rows) seen.add(String(r.employee_id));
    }
    return seen;
  })();
  const leaveP = (async () => {
    if (activeIds.length === 0) return [];
    const [grants, logs] = await Promise.all([fetchGrants(activeIds), fetchLeaveLogs(activeIds, addDays(today, -LEAVE_SINCE))]);
    return activeIds.map((id) => ({
      id, days: summarizeLeave(grants.filter((g) => g.employee_id === id), logs.uses.filter((u) => u.employee_id === id), today, LEAVE_AHEAD).expiring,
    })).filter((x) => x.days > 0);
  })();
  const [payrolls, loggedLastMonth, expiring, rates, table, closing] = await Promise.all([payrollsP, loggedP, leaveP, fetchRates(), fetchTaxTable(today), fetchClosings(last)]);
  if (payrolls.error) throw payrolls.error;
  const heads: HomePayroll[] = ((payrolls.data || []) as unknown as Row[]).map((p) => ({
    workplace_id: String(p.workplace_id), month: String(p.month), pay_date: String(p.pay_date ?? ""), status: p.status === "confirmed" ? "confirmed" : "draft",
  }));
  const rate = rateOn(rates, today);
  return buildTodos({
    today, workplaces, employees, payrolls: heads, loggedLastMonth, expiring,
    rate: { exists: !!rate, checked: !!rate?.checked, min_wage: num(rate?.min_wage) },
    taxTable: !!table,
    closing: { ready: closing.ready, closed: new Set(closing.closed.map((c) => c.workplace_id)) },
  });
}

// 구역 하나를 불러온다. 실패하면 null 과 화면에 보일 문장(자세한 것은 서버 로그에만).
async function section<T>(name: string, run: () => Promise<T>): Promise<{ value: T | null; error?: string }> {
  try {
    return { value: await run() };
  } catch (err) {
    const pending = isHrPending(err);
    console.error(`[hr-home] ${name}:`, (err as { message?: string })?.message || err);
    return { value: null, error: pending ? "DB 준비 전입니다. supabase/migrations/hr 의 SQL 을 번호 순서대로 적용하세요." : "불러오지 못했습니다. 잠시 뒤 다시 여세요." };
  }
}

// 직원·사업장을 읽지 못하면 던진다(첫 화면 전체가 오류). 그 뒤 세 구역은 따로 실패할 수 있다.
export async function loadHome(today: string): Promise<HomeBundle> {
  const [workplaces, employees] = await Promise.all([fetchWorkplaces(), fetchEmployees(today)]);
  const [status, tax, todos] = await Promise.all([
    section("status", () => loadStatus(today, workplaces, employees)),
    section("tax", () => loadTaxEvents(today)),
    section("todos", () => loadTodos(today, workplaces, employees)),
  ]);
  const errors: HomeBundle["errors"] = {};
  if (status.error) errors.status = status.error;
  if (tax.error) errors.tax = tax.error;
  if (todos.error) errors.todos = todos.error;
  return { today, status: status.value, tax: tax.value, todos: todos.value, errors };
}
