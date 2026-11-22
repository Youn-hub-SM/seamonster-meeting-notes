// 월 급여 — 화면과 서버가 같이 쓰는 타입·순수 계산. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  근무대장(hr-work.ts)이 낸 "시간"에 임금을 곱해 지급액을 만들고, 요율·간이세액표로 공제를 낸다(docs/payroll-leave-plan.md 4-2·5-2).
//  화면은 이 함수로 미리 보여 주고, 서버는 저장·확정 때 같은 함수로 다시 계산한다 — 화면이 보낸 금액을 믿지 않는다.
//
//  계산 기준(바꾸면 급여가 달라진다):
//   · 시급제: 기본급 = 일한 시간 × 그날의 시급(임금 이력에서 그 근무일에 유효한 줄). 달 중간에 시급이 바뀌면 날짜별로 나눠 곱한다.
//       연장·야간 = 시간 × 시급 × 0.5, 휴일 근무 = 8시간까지 × 0.5 + 넘은 시간 × 1.0 (모두 '가산분' — 일한 시간 자체는 기본급에 들어 있다).
//       주휴 = 이 달에 넣는 주의 주휴 시간 × 그 주 마지막 날의 시급. 연차·유급 휴일 = 하루 소정근로시간 × 시급.
//       가산은 사업장이 5인 이상일 때만, 주휴는 사업장이 자동 계산을 켰을 때만 넣는다(시간은 늘 보여 준다).
//   · 월급제: 기본급 = 그 달 마지막 재직일에 유효한 월급. 근무대장으로 계산하지 않는다(가산·일할은 손으로 고친다).
//   · 금액은 항목마다 원 단위로 반올림한다. 보험료·세액은 10원 미만을 버린다.
//   · 국민연금 = 기준소득월액(천 원 미만 버림, 상·하한) × 요율 ÷ 2. 건강보험 = 보수월액 × 요율 ÷ 2(근로자 몫 상·하한).
//       장기요양 = 건강보험료 × (장기요양 요율 ÷ 건강보험 요율). 고용보험 = 과세 급여 × 요율.
//       국민연금·건강보험의 기준은 직원별로 공단 고지 금액 또는 그달 과세 급여.
//   · 소득세 = 간이세액표(과세 급여 × 공제대상가족 수) − 자녀 공제 → 80·100·120%. 지방소득세 = 소득세 × 10%.
//       간이세액표는 국세청 원본을 올린 데이터에서 그대로 찾는다(산식으로 흉내 내지 않는다). 표가 없거나 표의 범위를 넘으면
//       자동으로 내지 않고 직접 넣게 한다.
//   · 4대보험 요율·최저임금은 귀속월 1일, 자녀 공제와 간이세액표는 지급일에 유효한 줄.

import { numText, rateOn, wageOn, type Rate, type Wage } from "./hr";
import { hoursText, monthRange, round2, summarizeMonth, type MonthSummary, type WorkEmployee, type WorkLog, type WorkPlace } from "./hr-work";

// ── 타입 ────────────────────────────────────────────────────────────
export type PayEmployee = WorkEmployee & {
  id: string; workplace_id: string; emp_no: string; name: string; dept: string; position: string; job: string;
  birth_date: string | null; pay_type: "hourly" | "monthly";
  dependents: number; children: number; tax_rate: 80 | 100 | 120;
  ins_pension: boolean; ins_health: boolean; ins_employment: boolean;
  ins_basis: "notice" | "actual"; pension_base: number; health_base: number;
  wages: Wage[];
};
export type PayWorkplace = WorkPlace & {
  id: string; name: string; biz_no: string; ceo: string; payday: number; accident_rate: number; employ_extra_rate: number;
};

// 급여 항목(직접 넣는 것). 근무대장에서 나오는 지급 6가지와 법정 공제 6가지는 표가 아니라 코드에 있다(SYSTEM_PAY·SYSTEM_DEDUCT).
export const ITEM_TAX_KINDS = ["taxable", "meal", "car", "childcare", "exempt"] as const;
export type ItemTaxKind = (typeof ITEM_TAX_KINDS)[number];
export const ITEM_TAX_LABEL: Record<ItemTaxKind, string> = {
  taxable: "과세", meal: "비과세(식대)", car: "비과세(자가운전)", childcare: "비과세(보육수당)", exempt: "비과세(한도 없음)",
};
export type PayItemDef = {
  id: string; name: string; kind: "pay" | "deduct"; tax: ItemTaxKind;
  fixed: boolean;      // 매월 고정 — 한 번 넣은 금액이 다음 달에도 채워진다
  sort: number; active: boolean;
};

export const SYSTEM_PAY = ["base", "weekly", "overtime", "night", "holiday", "paid_leave"] as const;
export const SYSTEM_DEDUCT = ["pension", "health", "ltc", "employment", "income_tax", "local_tax"] as const;
export type SystemCode = (typeof SYSTEM_PAY)[number] | (typeof SYSTEM_DEDUCT)[number];
export const SYSTEM_LABEL: Record<SystemCode, string> = {
  base: "기본급", weekly: "주휴수당", overtime: "연장수당", night: "야간수당", holiday: "휴일근로수당", paid_leave: "연차·유급 휴일",
  pension: "국민연금", health: "건강보험", ltc: "장기요양", employment: "고용보험", income_tax: "소득세", local_tax: "지방소득세",
};
const isSystem = (c: string): c is SystemCode => (SYSTEM_PAY as readonly string[]).includes(c) || (SYSTEM_DEDUCT as readonly string[]).includes(c);

// 간이세액표: 줄 = [이상(원), 미만(원), 가족 1명 세액, …, 가족 11명 세액]. 이상 오름차순.
export type TaxTable = { effective_from: string; rows: number[][] };

// 한 직원의 그달 입력(손으로 넣거나 고친 것만). 자동 계산값은 저장하지 않는다.
export type LineInputs = {
  overrides: Record<string, number>;                          // 자동 항목을 손으로 고친 금액(코드 → 원)
  extras: Record<string, { amount: number; qty?: number }>;   // 직접 넣는 항목(항목 id → 금액, 보육수당은 자녀 수)
  memo?: string;
};
export const emptyInputs = (): LineInputs => ({ overrides: {}, extras: {}, memo: "" });

export type PayLineItem = {
  code: string;            // 자동 항목은 SystemCode, 직접 넣는 항목은 "x:<항목 id>"
  name: string;
  kind: "pay" | "deduct";
  amount: number;          // 최종 금액(원)
  exempt: number;          // 그 가운데 비과세(지급 항목만)
  auto: number | null;     // 자동 계산값. null = 자동으로 내지 못함(직접 넣는 항목 포함)
  edited: boolean;         // 자동 계산값을 손으로 고쳤는가
  calc: string;            // 계산 방법(명세서에 찍는다)
};
export type PayBasis = {
  pay_type: "hourly" | "monthly";
  wage: number;            // 그 달 마지막에 유효한 시급 또는 월급
  workDays: number; worked: number; overtime: number; night: number; holiday: number;
  weeklyHours: number; paidHours: number; absentDays: number; missingDays: number; scheduledDays: number;
  premium: boolean; weekly: boolean;
};
export type PayResult = {
  employee_id: string; month: string;
  basis: PayBasis;
  items: PayLineItem[];
  pay_total: number; taxable_total: number; exempt_total: number; deduct_total: number; net_pay: number;
  employer: { pension: number; health: number; ltc: number; employment: number; accident: number; total: number };
  warnings: string[];
};

// 월 급여 머리와 저장된 줄. snapshot = 그때의 직원 정보(확정한 뒤 인사대장이 바뀌어도 급여대장·명세서는 그대로)
export type PayrollHead = {
  id: string; workplace_id: string; month: string; pay_date: string; status: "draft" | "confirmed";
  confirmed_by: string; confirmed_at: string | null; updated_at: string;
};
export type PaySnapshot = {
  name: string; emp_no: string; dept: string; position: string; job: string;
  birth_date: string | null; hire_date: string; pay_type: "hourly" | "monthly";
};
export type SavedLine = { employee_id: string; inputs: LineInputs; result: PayResult | null; snapshot: PaySnapshot };
export const snapshotOf = (e: PayEmployee): PaySnapshot => ({
  name: e.name, emp_no: e.emp_no, dept: e.dept, position: e.position, job: e.job, birth_date: e.birth_date, hire_date: e.hire_date, pay_type: e.pay_type,
});
// 화면이 한 번에 받는 것(GET /api/hr/payroll)
export type PayBundle = {
  month: string; workplace_id: string;
  workplaces: (PayWorkplace & { active: boolean })[];
  payroll: PayrollHead | null;
  lines: SavedLine[];
  employees: PayEmployee[];                 // 그 달 그 사업장 재직자(확정된 달에는 비어 있다 — 저장된 줄만 쓴다)
  logs: (WorkLog & { employee_id: string })[];
  rates: Rate[];
  tax: TaxTable | null;                     // 지급일에 유효한 간이세액표
  items: PayItemDef[];
  fixed: Record<string, Record<string, { amount: number; qty: number }>>;   // 직원 → 항목 → 고정 금액
  affiliations: Record<string, string>;     // 직원 → 소속(지금 인사대장의 값 — 소속별로 좁혀 볼 때만 쓴다. 금액에는 닿지 않는다)
};

// ── 숫자 ────────────────────────────────────────────────────────────
const floor10 = (n: number): number => Math.floor(n / 10) * 10;
// 금액 × 요율(%) ÷ div — 요율을 정수로 바꿔 곱해 소수 오차로 10원이 깎이는 일을 막는다(요율은 소수 5자리까지)
const pct = (base: number, rate: number, div = 1): number => (Math.round(base) * Math.round(rate * 1e5)) / (1e7 * div);
const won = (n: number): string => `${numText(n)}원`;
export const amountOf = (v: unknown): number => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

// ── 간이세액표 ──────────────────────────────────────────────────────
// 과세 급여(원)·공제대상가족 수 → 표의 세액. 표의 첫 줄보다 적으면 0, 표의 범위를 넘으면 null(직접 넣는다).
export function taxFromTable(table: TaxTable | null, taxable: number, dependents: number): number | null {
  if (!table || table.rows.length === 0) return null;
  const col = 1 + Math.min(11, Math.max(1, Math.round(dependents) || 1));
  const rows = table.rows;
  if (taxable < rows[0][0]) return 0;
  // 이분 탐색: 이상(lo) 이 taxable 이하인 마지막 줄
  let a = 0, b = rows.length - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (rows[m][0] <= taxable) a = m; else b = m - 1; }
  const r = rows[a];
  if (taxable < r[1] || (r[0] === r[1] && taxable === r[0])) return r[col] ?? 0;
  return null; // 줄 사이 빈틈이거나 표의 마지막 줄을 넘음
}

// 엑셀에서 읽은 칸들 → 간이세액표 줄. 국세청 조견표는 [이상(천원), 미만(천원), 1명 … 11명(원)] 이 한 줄이다.
//  숫자 줄만 고른다(머리글·설명 줄은 버린다). 마지막 '10,000천원' 줄은 미만이 비어 있어 이상 = 미만으로 둔다.
export function parseTaxSheet(cells: unknown[][]): { rows: number[][]; error: string } {
  const toNum = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v ?? "").replace(/[,\s]|천원|원/g, "");   // "10,000천원" → 10000
    if (s === "") return null;
    if (s === "-" || s === "–") return 0;
    return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
  };
  const rows: number[][] = [];
  for (const raw of cells) {
    const line = (raw || []).map(toNum);
    while (line.length > 0 && line[line.length - 1] == null) line.pop();
    const first = line.findIndex((v) => v != null);
    if (first < 0) continue;
    const vals = line.slice(first);
    let lo: number, hi: number, taxes: (number | null)[];
    if (vals.length === 13) { lo = vals[0] ?? NaN; hi = vals[1] ?? lo; taxes = vals.slice(2); }                // 미만 칸이 비면 마지막 줄
    else if (vals.length === 12) { lo = vals[0] ?? NaN; hi = lo; taxes = vals.slice(1); }  // 마지막 줄(미만 없음)
    else continue;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) continue;
    if (taxes.some((t) => t != null && (t < 0 || !Number.isInteger(t)))) continue;
    rows.push([Math.round(lo * 1000), Math.round(hi * 1000), ...taxes.map((t) => t ?? 0)]);
  }
  rows.sort((x, y) => x[0] - y[0]);
  if (rows.length < 100) return { rows: [], error: `세액표 줄을 ${rows.length}개만 찾았습니다. 국세청 근로소득 간이세액표(조견표) 엑셀인지 확인하세요.` };
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === rows[i - 1][0]) return { rows: [], error: `같은 금액 구간이 두 번 있습니다(${numText(rows[i][0])}원).` };
    if (rows[i][0] !== rows[i - 1][1]) return { rows: [], error: `금액 구간이 이어지지 않습니다(${numText(rows[i - 1][1])}원 다음이 ${numText(rows[i][0])}원).` };
  }
  // 가족 수가 늘면 세액은 줄거나 같다 — 칸이 밀린 파일을 걸러낸다
  for (const r of rows) for (let c = 3; c < 13; c++) if (r[c] > r[c - 1]) return { rows: [], error: `${numText(r[0])}원 줄의 세액이 가족 수 순서와 맞지 않습니다. 칸이 밀렸는지 확인하세요.` };
  return { rows, error: "" };
}

// ── 한 직원의 한 달 ─────────────────────────────────────────────────
export type PayArgs = {
  e: PayEmployee; wp: PayWorkplace;
  logs: WorkLog[];           // 그 직원의 기록(그 달과 겹치는 주를 덮는 범위)
  month: string;             // 귀속월 YYYY-MM
  payDate: string;           // 지급일 YYYY-MM-DD
  rates: Rate[];
  tax: TaxTable | null;      // 지급일에 유효한 간이세액표
  items: PayItemDef[];       // 직접 넣는 항목(사용 중인 것)
  inputs: LineInputs;
};

type Bucket = Map<number, number>; // 시급 → 시간
const add = (b: Bucket, wage: number, hours: number) => { if (hours > 0) b.set(wage, round2((b.get(wage) || 0) + hours)); };
const sum = (b: Bucket, factor = 1) => { let s = 0; for (const [w, h] of b) s += h * w * factor; return Math.round(s); };
const text = (b: Bucket, factor?: string) => [...b].map(([w, h]) => `${hoursText(h)}시간 × ${won(w)}${factor ? ` × ${factor}` : ""}`).join(" + ");

export function computePay(a: PayArgs): PayResult {
  const { e, wp, month, inputs } = a;
  const { from, to, days } = monthRange(month);
  const warnings: string[] = [];
  const rate = rateOn(a.rates, from);
  const rateAtPay = rateOn(a.rates, a.payDate) || rate;
  if (!rate) warnings.push("이 달에 유효한 요율이 없습니다");

  const s: MonthSummary = summarizeMonth(e, wp, a.logs, month);
  const lastDay = e.leave_date && e.leave_date < to ? e.leave_date : to;
  const lastWage = wageOn(e.wages, lastDay);
  const basis: PayBasis = {
    pay_type: e.pay_type, wage: (e.pay_type === "hourly" ? lastWage?.hourly_wage : lastWage?.monthly_wage) || 0,
    workDays: s.workDays, worked: s.worked, overtime: s.overtime, night: s.night, holiday: round2(s.holidayBase + s.holidayOver),
    weeklyHours: s.weeklyHours, paidHours: round2(s.paidHolidayHours + s.leaveHours), absentDays: s.absentDays, missingDays: s.missingDays,
    scheduledDays: s.scheduledDays, premium: s.applies.premium, weekly: s.applies.weekly,
  };

  // ── 지급(자동) ──
  const auto: Record<string, { amount: number; calc: string }> = {};
  if (e.pay_type === "hourly") {
    const byDate = new Map(a.logs.map((l) => [l.work_date, l]));
    const base: Bucket = new Map(), ot: Bucket = new Map(), night: Bucket = new Map(), hol8: Bucket = new Map(), holOver: Bucket = new Map(), paid: Bucket = new Map(), weekly: Bucket = new Map();
    let noWage = false;
    for (const d of days) {
      if (d < e.hire_date || (e.leave_date && d > e.leave_date)) continue;
      const log = byDate.get(d);
      if (!log) continue;
      const w = wageOn(e.wages, d)?.hourly_wage || 0;
      if (!w && (log.hours > 0 || log.leave_days > 0 || log.kind === "paid_holiday")) noWage = true;
      if (log.kind === "work" || log.kind === "holiday_work") {
        add(base, w, log.hours || 0);
        add(night, w, log.night_hours || 0);
        if (log.kind === "work") add(ot, w, s.overtimeByDay[d] || 0);
        else { add(hol8, w, Math.min(log.hours || 0, 8)); add(holOver, w, Math.max(0, (log.hours || 0) - 8)); }
      } else if (log.kind === "paid_holiday") add(paid, w, e.daily_hours || 0);
      add(paid, w, round2((log.leave_days || 0) * (e.daily_hours || 0)));
    }
    for (const wk of s.weeks) {
      if (wk.payMonth !== month || wk.weeklyHours <= 0) continue;
      const end = e.leave_date && e.leave_date < wk.end ? e.leave_date : wk.end;
      const w = (wageOn(e.wages, end) || wageOn(e.wages, wk.start))?.hourly_wage || 0;
      if (!w) noWage = true;
      add(weekly, w, wk.weeklyHours);
    }
    if (noWage) warnings.push("시급이 없는 날이 있습니다 — 임금 적용 시작일을 확인하세요");
    auto.base = { amount: sum(base), calc: text(base) };
    auto.weekly = s.applies.weekly ? { amount: sum(weekly), calc: text(weekly) } : { amount: 0, calc: weekly.size ? "주휴수당 자동 계산을 끈 사업장" : "" };
    const off = "5인 미만 사업장 — 가산하지 않음";
    auto.overtime = s.applies.premium ? { amount: sum(ot, 0.5), calc: text(ot, "0.5") } : { amount: 0, calc: ot.size ? off : "" };
    auto.night = s.applies.premium ? { amount: sum(night, 0.5), calc: text(night, "0.5") } : { amount: 0, calc: night.size ? off : "" };
    auto.holiday = s.applies.premium
      ? { amount: sum(hol8, 0.5) + sum(holOver, 1), calc: [text(hol8, "0.5"), text(holOver, "1.0")].filter(Boolean).join(" + ") }
      : { amount: 0, calc: hol8.size ? off : "" };
    auto.paid_leave = { amount: sum(paid), calc: text(paid) };

    const minWage = rate?.min_wage || 0;
    const low = [...new Set([...base.keys(), ...weekly.keys(), ...paid.keys()])].filter((w) => w > 0 && w < minWage);
    if (low.length) warnings.push(`시급 ${low.map(won).join("·")}이 최저임금 ${won(minWage)}보다 낮습니다`);
    if (s.missingDays > 0) warnings.push(`근무대장 입력 전 ${s.missingDays}일`);
  } else {
    const m = lastWage?.monthly_wage || 0;
    if (!m) warnings.push("월급이 없습니다 — 임금 적용 시작일을 확인하세요");
    auto.base = { amount: m, calc: m ? `월급 ${won(m)}` : "" };
    for (const c of ["weekly", "overtime", "night", "holiday", "paid_leave"]) auto[c] = { amount: 0, calc: "" };
    if (e.hire_date > from || (e.leave_date && e.leave_date < to)) warnings.push("달 중간에 입사·퇴사 — 기본급을 일할로 고치세요");
  }

  const items: PayLineItem[] = [];
  const pick = (code: SystemCode, kind: "pay" | "deduct", autoAmount: number | null, calc: string) => {
    const o = inputs.overrides?.[code];
    const has = typeof o === "number" && Number.isFinite(o) && (kind === "deduct" || o >= 0) && Math.round(o) !== (autoAmount ?? NaN);
    const amount = has ? Math.round(o) : autoAmount ?? 0;
    items.push({ code, name: SYSTEM_LABEL[code], kind, amount, exempt: 0, auto: autoAmount, edited: has, calc: has ? `직접 입력${autoAmount != null && calc ? ` (자동 ${won(autoAmount)} = ${calc})` : ""}` : calc });
    return amount;
  };
  for (const c of SYSTEM_PAY) pick(c, "pay", auto[c].amount, auto[c].calc);

  // ── 직접 넣는 지급 항목 ──
  const defs = [...a.items].filter((d) => d.active).sort((x, y) => x.sort - y.sort || x.name.localeCompare(y.name));
  for (const d of defs.filter((x) => x.kind === "pay")) {
    const inp = inputs.extras?.[d.id];
    const amount = Math.max(0, amountOf(inp?.amount));
    if (!amount) continue;
    const qty = Math.max(1, Math.round(Number(inp?.qty) || 1));
    const limit = d.tax === "meal" ? rateAtPay?.meal_limit ?? 0 : d.tax === "car" ? rateAtPay?.car_limit ?? 0 : d.tax === "childcare" ? (rateAtPay?.childcare_limit ?? 0) * qty : 0;
    const exempt = d.tax === "taxable" ? 0 : d.tax === "exempt" ? amount : Math.min(amount, limit);
    const calc = d.tax === "taxable" ? "" : d.tax === "exempt" ? "비과세" : exempt < amount ? `비과세 ${won(exempt)}(한도), 과세 ${won(amount - exempt)}` : "비과세";
    items.push({ code: `x:${d.id}`, name: d.name, kind: "pay", amount, exempt, auto: null, edited: false, calc });
  }
  const pay_total = items.filter((i) => i.kind === "pay").reduce((t, i) => t + i.amount, 0);
  const exempt_total = items.reduce((t, i) => t + i.exempt, 0);
  const taxable_total = pay_total - exempt_total;

  // ── 공제(자동) ──
  const employer = { pension: 0, health: 0, ltc: 0, employment: 0, accident: 0, total: 0 };
  let pension = 0, health = 0, ltc = 0, employment = 0;
  let pensionCalc = "", healthCalc = "", ltcCalc = "", employCalc = "";
  if (rate) {
    if (e.ins_pension) {
      const raw = e.ins_basis === "notice" ? e.pension_base : taxable_total;
      if (raw > 0) {
        const b = Math.min(rate.pension_max, Math.max(rate.pension_min, Math.floor(raw / 1000) * 1000));
        pension = floor10(pct(b, rate.pension_rate, 2));
        pensionCalc = `기준소득월액 ${won(b)} × ${rate.pension_rate}% ÷ 2`;
      } else if (e.ins_basis === "notice") warnings.push("국민연금 기준소득월액이 비어 있습니다");
      employer.pension = pension;
    }
    if (e.ins_health) {
      const raw = e.ins_basis === "notice" ? e.health_base : taxable_total;
      if (raw > 0) {
        let h = pct(raw, rate.health_rate, 2);
        if (rate.health_max_premium > 0) h = Math.min(h, rate.health_max_premium);
        if (rate.health_min_premium > 0) h = Math.max(h, rate.health_min_premium);
        health = floor10(h);
        ltc = rate.health_rate > 0 ? floor10((h * Math.round(rate.ltc_rate * 1e5)) / Math.round(rate.health_rate * 1e5)) : 0;
        healthCalc = `보수월액 ${won(raw)} × ${rate.health_rate}% ÷ 2`;
        ltcCalc = `보수월액 ${won(raw)} × ${rate.ltc_rate}% ÷ 2`;
      } else if (e.ins_basis === "notice") warnings.push("건강보험 보수월액이 비어 있습니다");
      employer.health = health; employer.ltc = ltc;
    }
    if (e.ins_employment && taxable_total > 0) {
      employment = floor10(pct(taxable_total, rate.employ_rate));
      employCalc = `과세 급여 ${won(taxable_total)} × ${rate.employ_rate}%`;
      employer.employment = floor10(pct(taxable_total, rate.employ_employer_rate + (wp.employ_extra_rate || 0)));
    }
    employer.accident = taxable_total > 0 ? floor10(pct(taxable_total, wp.accident_rate || 0)) : 0;
  }
  pick("pension", "deduct", pension, pensionCalc);
  pick("health", "deduct", health, healthCalc);
  pick("ltc", "deduct", ltc, ltcCalc);
  pick("employment", "deduct", employment, employCalc);

  // 소득세
  let incomeAuto: number | null = null, incomeCalc = "";
  const tableTax = taxable_total > 0 ? taxFromTable(a.tax, taxable_total, e.dependents) : 0;
  if (tableTax == null) {
    warnings.push(a.tax ? "과세 급여가 간이세액표의 범위를 넘습니다 — 소득세를 직접 넣으세요" : "간이세액표가 없습니다 — 요율 화면에서 올리거나 소득세를 직접 넣으세요");
  } else {
    const n = Math.max(0, Math.round(e.children) || 0);
    const credit = !rateAtPay || n === 0 ? 0 : n === 1 ? rateAtPay.child_credit_1 : rateAtPay.child_credit_2 + (n - 2) * rateAtPay.child_credit_more;
    incomeAuto = floor10((Math.max(0, tableTax - credit) * e.tax_rate) / 100);
    incomeCalc = taxable_total > 0
      ? `간이세액표 ${won(tableTax)}(과세 ${won(taxable_total)}·가족 ${e.dependents}명)${credit ? ` − 자녀 공제 ${won(credit)}` : ""}${e.tax_rate !== 100 ? ` × ${e.tax_rate}%` : ""}`
      : "";
  }
  const income = pick("income_tax", "deduct", incomeAuto, incomeCalc);
  pick("local_tax", "deduct", floor10(Math.max(0, income) * 0.1), income > 0 ? "소득세 × 10%" : "");

  // ── 직접 넣는 공제 항목(정산은 돌려받으면 음수) ──
  for (const d of defs.filter((x) => x.kind === "deduct")) {
    const amount = amountOf(inputs.extras?.[d.id]?.amount);
    if (!amount) continue;
    items.push({ code: `x:${d.id}`, name: d.name, kind: "deduct", amount, exempt: 0, auto: null, edited: false, calc: "" });
  }
  const deduct_total = items.filter((i) => i.kind === "deduct").reduce((t, i) => t + i.amount, 0);
  employer.total = employer.pension + employer.health + employer.ltc + employer.employment + employer.accident;

  for (const k of Object.keys(inputs.overrides || {})) if (!isSystem(k)) warnings.push(`알 수 없는 항목(${k})은 무시했습니다`);
  return { employee_id: e.id, month, basis, items, pay_total, taxable_total, exempt_total, deduct_total, net_pay: pay_total - deduct_total, employer, warnings };
}

// 새 달의 첫 입력: '매월 고정' 항목은 직원에게 저장해 둔 금액으로 채운다
export function initialInputs(items: PayItemDef[], fixedPay: Record<string, { amount: number; qty?: number }> | undefined): LineInputs {
  const extras: LineInputs["extras"] = {};
  for (const d of items) {
    const f = d.active && d.fixed ? fixedPay?.[d.id] : undefined;
    if (f && f.amount) extras[d.id] = { amount: f.amount, ...(d.tax === "childcare" ? { qty: f.qty || 1 } : {}) };
  }
  return { overrides: {}, extras, memo: "" };
}

// 저장할 수 있는 모양으로 고친다(모르는 코드·항목, 숫자 아닌 값은 버린다)
export function normalizeInputs(raw: unknown, items: PayItemDef[]): LineInputs {
  const r = (raw && typeof raw === "object" ? raw : {}) as { overrides?: unknown; extras?: unknown; memo?: unknown };
  const out = emptyInputs();
  const ov = (r.overrides && typeof r.overrides === "object" ? r.overrides : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ov)) {
    if (!isSystem(k) || v === "" || v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && Math.abs(n) <= 1e9) out.overrides[k] = Math.round(n);
  }
  const ex = (r.extras && typeof r.extras === "object" ? r.extras : {}) as Record<string, { amount?: unknown; qty?: unknown }>;
  const byId = new Map(items.map((d) => [d.id, d]));
  for (const [id, v] of Object.entries(ex)) {
    const d = byId.get(id);
    const n = Number(v?.amount);
    if (!d || !Number.isFinite(n) || n === 0 || Math.abs(n) > 1e9) continue;
    if (d.kind === "pay" && n < 0) continue;
    out.extras[id] = { amount: Math.round(n), ...(d.tax === "childcare" ? { qty: Math.min(20, Math.max(1, Math.round(Number(v?.qty) || 1))) } : {}) };
  }
  out.memo = String(r.memo ?? "").trim().slice(0, 300);
  return out;
}

// ── 급여대장 합계 ───────────────────────────────────────────────────
export type PayTotals = { pay_total: number; taxable_total: number; exempt_total: number; deduct_total: number; net_pay: number; employer: number; byCode: Record<string, number> };
export function sumResults(list: PayResult[]): PayTotals {
  const t: PayTotals = { pay_total: 0, taxable_total: 0, exempt_total: 0, deduct_total: 0, net_pay: 0, employer: 0, byCode: {} };
  for (const r of list) {
    t.pay_total += r.pay_total; t.taxable_total += r.taxable_total; t.exempt_total += r.exempt_total;
    t.deduct_total += r.deduct_total; t.net_pay += r.net_pay; t.employer += r.employer.total;
    for (const i of r.items) t.byCode[i.code] = (t.byCode[i.code] || 0) + i.amount;
  }
  return t;
}
export const itemAmount = (r: PayResult, code: string): number => r.items.find((i) => i.code === code)?.amount || 0;

// 지급일 기본값: 귀속월 다음 달의 사업장 지급일(그 달에 없는 날이면 말일)
export function defaultPayDate(month: string, payday: number): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(Math.max(1, payday || 10), last))).toISOString().slice(0, 10);
}
