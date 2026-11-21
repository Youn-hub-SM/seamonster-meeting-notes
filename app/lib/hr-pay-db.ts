// 월 급여 — 서버 전용 조회·저장 준비. 화면에서 import 하지 말 것.

import { hrDb, hrJson } from "./hr-db";
import { wagesOf } from "./hr-employees";
import { isDate, type Rate } from "./hr";
import { isMonth, monthRange, type RosterLog } from "./hr-work";
import { fetchLogs } from "./hr-work-db";
import {
  ITEM_TAX_KINDS, computePay, defaultPayDate, initialInputs, normalizeInputs, snapshotOf,
  type ItemTaxKind, type LineInputs, type PayBundle, type PayEmployee, type PayItemDef, type PayResult, type PayWorkplace, type PayrollHead, type SavedLine, type TaxTable,
} from "./hr-pay";

export const HR_PENDING_003 = "DB 준비 전입니다. supabase/migrations/hr/003_payroll.sql 을 적용하세요.";
export const UUID_RE = /^[0-9a-f-]{36}$/i;

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

const EMP_COLS = "id,workplace_id,emp_no,name,dept,position,job,birth_date,pay_type,hire_date,leave_date,work_days,daily_hours," +
  "dependents,children,tax_rate,ins_pension,ins_health,ins_employment,ins_basis,pension_base,health_base";
const WP_COLS = "id,name,biz_no,ceo,payday,accident_rate,employ_extra_rate,five_plus,week_start,weekly_pay_month,auto_weekly,active";
const RATE_COLS = "id,effective_from,pension_rate,pension_min,pension_max,health_rate,health_min_premium,health_max_premium,ltc_rate,employ_rate,employ_employer_rate," +
  "min_wage,child_credit_1,child_credit_2,child_credit_more,meal_limit,car_limit,childcare_limit,note,checked";
export const ITEM_COLS = "id,name,kind,tax,fixed,sort,active";

// DB 함수가 일부러 거절한 것(확정된 달 등) — 그 문장을 그대로 409 로 돌려준다
export function refusal(err: unknown) {
  const e = err as { code?: string; message?: string };
  return e?.code === "P0001" && e.message ? hrJson({ ok: false, error: e.message }, 409) : null;
}

export function toPayItem(r: Row): PayItemDef {
  const tax = (ITEM_TAX_KINDS as readonly string[]).includes(String(r.tax)) ? (r.tax as ItemTaxKind) : "taxable";
  return { id: String(r.id), name: String(r.name ?? ""), kind: r.kind === "deduct" ? "deduct" : "pay", tax, fixed: !!r.fixed, sort: num(r.sort), active: r.active !== false };
}

export async function fetchPayWorkplaces(): Promise<PayBundle["workplaces"]> {
  const { data, error } = await hrDb().from("workplaces").select(WP_COLS).order("sort").order("created_at");
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map((r) => ({
    id: String(r.id), name: String(r.name ?? ""), biz_no: String(r.biz_no ?? ""), ceo: String(r.ceo ?? ""),
    payday: num(r.payday) || 10, accident_rate: num(r.accident_rate), employ_extra_rate: num(r.employ_extra_rate),
    five_plus: !!r.five_plus, week_start: num(r.week_start) || 1, weekly_pay_month: r.weekly_pay_month === "start" ? "start" : "end",
    auto_weekly: !!r.auto_weekly, active: r.active !== false,
  }));
}

// 그 달에 하루라도 그 사업장에 재직한 직원(임금 이력 포함)
export async function fetchPayEmployees(month: string, workplaceId: string): Promise<PayEmployee[]> {
  const { from, to } = monthRange(month);
  const { data, error } = await hrDb().from("employees").select(EMP_COLS)
    .eq("workplace_id", workplaceId).lte("hire_date", to).or(`leave_date.is.null,leave_date.gte.${from}`)
    .order("emp_no").order("hire_date").order("name");
  if (error) throw error;
  const rows = (data || []) as unknown as Row[];
  const wages = await wagesOf(rows.map((r) => String(r.id)));
  return rows.map((r) => ({
    id: String(r.id), workplace_id: String(r.workplace_id), emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""),
    dept: String(r.dept ?? ""), position: String(r.position ?? ""), job: String(r.job ?? ""),
    birth_date: (r.birth_date as string) || null, pay_type: r.pay_type === "monthly" ? "monthly" : "hourly",
    hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null,
    work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [], daily_hours: num(r.daily_hours),
    dependents: num(r.dependents) || 1, children: num(r.children), tax_rate: ([80, 100, 120].includes(num(r.tax_rate)) ? num(r.tax_rate) : 100) as PayEmployee["tax_rate"],
    ins_pension: !!r.ins_pension, ins_health: !!r.ins_health, ins_employment: !!r.ins_employment,
    ins_basis: r.ins_basis === "actual" ? "actual" : "notice", pension_base: num(r.pension_base), health_base: num(r.health_base),
    wages: wages.get(String(r.id)) || [],
  }));
}

export async function fetchRates(): Promise<Rate[]> {
  const { data, error } = await hrDb().from("rates").select(RATE_COLS).order("effective_from", { ascending: false });
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map((r) => {
    const o: Row = { ...r };
    for (const k of ["pension_rate", "health_rate", "ltc_rate", "employ_rate", "employ_employer_rate"]) o[k] = Number(r[k]);
    return o as unknown as Rate;
  });
}

// 지급일에 유효한 간이세액표(적용 시작일이 지급일 이전인 것 중 가장 늦은 것). 없으면 null.
export async function fetchTaxTable(payDate: string): Promise<TaxTable | null> {
  const { data, error } = await hrDb().from("tax_tables").select("effective_from,rows").lte("effective_from", payDate).order("effective_from", { ascending: false }).limit(1);
  if (error) throw error;
  const r = ((data || []) as unknown as Row[])[0];
  if (!r || !Array.isArray(r.rows)) return null;
  return { effective_from: String(r.effective_from), rows: r.rows as number[][] };
}

export async function fetchPayItems(): Promise<PayItemDef[]> {
  const { data, error } = await hrDb().from("pay_items").select(ITEM_COLS).order("sort").order("name");
  if (error) throw error;
  return ((data || []) as unknown as Row[]).map(toPayItem);
}

export async function fetchFixedPay(employeeIds: string[]): Promise<PayBundle["fixed"]> {
  const out: PayBundle["fixed"] = {};
  for (let i = 0; i < employeeIds.length; i += 200) {
    const { data, error } = await hrDb().from("employee_pay").select("employee_id,item_id,amount,qty").in("employee_id", employeeIds.slice(i, i + 200));
    if (error) throw error;
    for (const r of (data || []) as unknown as Row[]) (out[String(r.employee_id)] ||= {})[String(r.item_id)] = { amount: num(r.amount), qty: num(r.qty) || 1 };
  }
  return out;
}

export async function fetchPayroll(workplaceId: string, month: string): Promise<{ head: PayrollHead; lines: SavedLine[] } | null> {
  const { data, error } = await hrDb().from("payrolls").select("id,workplace_id,month,pay_date,status,confirmed_by,confirmed_at,updated_at")
    .eq("workplace_id", workplaceId).eq("month", month).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const h = data as unknown as Row;
  const head: PayrollHead = {
    id: String(h.id), workplace_id: String(h.workplace_id), month: String(h.month), pay_date: String(h.pay_date),
    status: h.status === "confirmed" ? "confirmed" : "draft", confirmed_by: String(h.confirmed_by ?? ""), confirmed_at: (h.confirmed_at as string) || null, updated_at: String(h.updated_at ?? ""),
  };
  const l = await hrDb().from("payroll_lines").select("employee_id,inputs,result,snapshot").eq("payroll_id", head.id).limit(1000);
  if (l.error) throw l.error;
  const lines: SavedLine[] = ((l.data || []) as unknown as Row[]).map((r) => {
    const result = r.result && typeof r.result === "object" && Array.isArray((r.result as PayResult).items) ? (r.result as PayResult) : null;
    return { employee_id: String(r.employee_id), inputs: (r.inputs || {}) as LineInputs, result, snapshot: (r.snapshot || {}) as SavedLine["snapshot"] };
  });
  // 급여대장 순서: 사번 → 성명
  lines.sort((a, b) => (a.snapshot.emp_no || "").localeCompare(b.snapshot.emp_no || "", "ko", { numeric: true }) || (a.snapshot.name || "").localeCompare(b.snapshot.name || "", "ko"));
  return { head, lines };
}

// 그 달 급여가 확정된 사업장(근무대장 화면이 잠금 표시에 쓴다). 003 미적용이면 빈 목록 — 잠금이 아직 없다.
export async function confirmedWorkplaces(month: string): Promise<string[]> {
  try {
    const { data, error } = await hrDb().from("payrolls").select("workplace_id").eq("month", month).eq("status", "confirmed");
    if (error) throw error;
    return ((data || []) as unknown as Row[]).map((r) => String(r.workplace_id));
  } catch { return []; }
}

// 화면이 한 번에 받는 묶음. 확정된 달은 저장된 줄만 준다(다시 계산하지 않는다).
export async function loadBundle(month: string, wantWorkplace: string): Promise<PayBundle | { error: string; status: number }> {
  if (!isMonth(month)) return { error: "달을 고르세요.", status: 400 };
  const workplaces = await fetchPayWorkplaces();
  const wp = workplaces.find((w) => w.id === wantWorkplace) || workplaces.find((w) => w.active) || workplaces[0];
  const empty: PayBundle = { month, workplace_id: wp?.id || "", workplaces, payroll: null, lines: [], employees: [], logs: [], rates: [], tax: null, items: [], fixed: {} };
  if (!wp) return empty;
  const [saved, items] = await Promise.all([fetchPayroll(wp.id, month), fetchPayItems()]);
  if (saved?.head.status === "confirmed") return { ...empty, payroll: saved.head, lines: saved.lines, items };
  const payDate = saved?.head.pay_date || defaultPayDate(month, wp.payday);
  const [employees, rates, tax] = await Promise.all([fetchPayEmployees(month, wp.id), fetchRates(), fetchTaxTable(payDate)]);
  const ids = employees.map((e) => e.id);
  const [logs, fixed] = await Promise.all([fetchLogs(month, ids), fetchFixedPay(ids)]);
  return { ...empty, payroll: saved?.head || null, lines: saved?.lines || [], employees, logs, rates, tax, items, fixed };
}

// 저장·확정 때 서버가 다시 계산한다. 화면이 보낸 것은 입력(inputs)뿐이고 금액은 믿지 않는다.
//  보내지 않은 직원은 저장된 입력을, 그것도 없으면 고정 항목만 채운 첫 입력을 쓴다.
export async function buildPayroll(args: { workplaceId: string; month: string; payDate: string; sent: Record<string, unknown> }): Promise<
  { ok: true; wp: PayWorkplace; lines: Row[]; fixed: Row[]; results: PayResult[] } | { ok: false; error: string; status: number }
> {
  const { workplaceId, month, payDate } = args;
  if (!UUID_RE.test(workplaceId)) return { ok: false, error: "없는 사업장입니다.", status: 404 };
  if (!isMonth(month)) return { ok: false, error: "달을 고르세요.", status: 400 };
  if (!isDate(payDate)) return { ok: false, error: "지급일을 입력하세요.", status: 400 };
  if (payDate < `${month}-01`) return { ok: false, error: "지급일이 귀속월보다 앞입니다.", status: 400 };
  const wp = (await fetchPayWorkplaces()).find((w) => w.id === workplaceId);
  if (!wp) return { ok: false, error: "없는 사업장입니다.", status: 404 };
  const [employees, rates, tax, items, saved] = await Promise.all([
    fetchPayEmployees(month, workplaceId), fetchRates(), fetchTaxTable(payDate), fetchPayItems(), fetchPayroll(workplaceId, month),
  ]);
  if (employees.length === 0) return { ok: false, error: "그 달에 재직한 직원이 없습니다.", status: 400 };
  const ids = employees.map((e) => e.id);
  const [logs, fixedPay] = await Promise.all([fetchLogs(month, ids), fetchFixedPay(ids)]);
  const logsOf = new Map<string, RosterLog[]>();
  for (const l of logs) { if (!logsOf.has(l.employee_id)) logsOf.set(l.employee_id, []); logsOf.get(l.employee_id)!.push(l); }
  const savedOf = new Map((saved?.lines || []).map((l) => [l.employee_id, l]));
  const active = items.filter((d) => d.active);

  const lines: Row[] = [], fixed: Row[] = [], results: PayResult[] = [];
  for (const e of employees) {
    const raw = Object.prototype.hasOwnProperty.call(args.sent, e.id) ? args.sent[e.id] : savedOf.get(e.id)?.inputs;
    const inputs = raw === undefined ? initialInputs(active, fixedPay[e.id]) : normalizeInputs(raw, active);
    const result = computePay({ e, wp, logs: logsOf.get(e.id) || [], month, payDate, rates, tax, items: active, inputs });
    results.push(result);
    lines.push({ employee_id: e.id, inputs, result, snapshot: snapshotOf(e), pay_total: result.pay_total, deduct_total: result.deduct_total, net_pay: result.net_pay });
    for (const d of active) if (d.fixed) fixed.push({ employee_id: e.id, item_id: d.id, amount: inputs.extras[d.id]?.amount || 0, qty: inputs.extras[d.id]?.qty || 1 });
  }
  return { ok: true, wp, lines, fixed, results };
}
