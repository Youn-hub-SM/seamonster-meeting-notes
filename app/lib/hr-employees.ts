// 인사대장 — 서버 전용(입력 검증·DB 줄 ↔ 화면 타입). 화면에서 import 하지 말 것.

import { hrDb } from "./hr-db";
import { encryptRrn, rrnHash } from "./hr-crypto";
import { EMP_TYPES, isDate, maskRrn, parseRrn, type Employee, type Wage } from "./hr";

// 화면으로 내보내는 칸. rrn_enc·rrn_hash 는 여기 없다 — 목록·상세 응답에 암호문조차 싣지 않는다.
const EMPLOYEE_COLS_BASE =
  "id,workplace_id,emp_no,name,rrn_masked,birth_date,gender,foreigner,address,phone,emergency,hire_date,leave_date,leave_reason," +
  "dept,position,job,emp_type,contract_start,contract_end,career,pay_type,work_days,work_start,work_end,break_min,daily_hours," +
  "dependents,children,tax_rate,ins_pension,ins_health,ins_employment,ins_basis,pension_base,health_base," +
  "bank,account_no,account_holder,leave_basis,memo,updated_at";
export const EMPLOYEE_COLS = `${EMPLOYEE_COLS_BASE},affiliation`;

type Row = Record<string, unknown>;

// ── 소속 칸(hr/006)이 아직 없는 DB 에서도 멈추지 않게 ────────────────
//  읽기: 소속 칸을 넣어 읽다가 '그 칸이 없다'는 오류면 소속 칸 없이 다시 읽는다(직원의 소속은 빈 값으로 보인다).
//  쓰기: 소속이 빈 값이면 그 칸을 빼고 다시 쓰고, 값이 있으면 'DB 준비 전(hr/006)'으로 거절한다 — 넣은 소속이 조용히 사라지지 않게.
export const HR_PENDING_006 = "DB 준비 전입니다. supabase/migrations/hr/006_affiliation.sql 을 적용하세요.";
export type DbResult = { data: unknown; error: { message?: string; code?: string } | null };
// '소속 칸이 없다'는 오류인가(읽기 = column … does not exist, 쓰기 = Could not find the … column … in the schema cache). 사업장의 affiliations 도 같이 잡는다.
export function missingAffiliation(err: unknown): boolean {
  const m = String((err as { message?: string } | null)?.message ?? "");
  return /affiliation/i.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}
// run(cols) 는 그 칸 목록으로 읽는 질의. extra = 뒤에 붙일 칸(rrn_hash 등).
export async function readEmployees(run: (cols: string) => PromiseLike<DbResult>, extra = ""): Promise<DbResult> {
  const tail = extra ? `,${extra}` : "";
  const first = await run(EMPLOYEE_COLS + tail);
  return first.error && missingAffiliation(first.error) ? await run(EMPLOYEE_COLS_BASE + tail) : first;
}
// run(row, cols) 는 그 줄을 쓰고 그 칸 목록으로 돌려받는 질의.
export async function writeEmployee(row: Row, run: (row: Row, cols: string) => PromiseLike<DbResult>): Promise<DbResult> {
  const first = await run(row, EMPLOYEE_COLS);
  if (!first.error || !missingAffiliation(first.error)) return first;
  if (String(row.affiliation ?? "").trim()) return { data: null, error: { code: "HR006", message: HR_PENDING_006 } };
  const rest = { ...row };
  delete rest.affiliation;
  return await run(rest, EMPLOYEE_COLS_BASE);
}
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export function toEmployee(r: Row, wages: Wage[]): Employee {
  return {
    id: String(r.id), workplace_id: String(r.workplace_id), emp_no: String(r.emp_no ?? ""), name: String(r.name ?? ""),
    affiliation: String(r.affiliation ?? ""),
    rrn_masked: String(r.rrn_masked ?? ""), has_rrn: !!r.rrn_masked,
    birth_date: (r.birth_date as string) || null, gender: (r.gender as Employee["gender"]) || "", foreigner: !!r.foreigner,
    address: String(r.address ?? ""), phone: String(r.phone ?? ""), emergency: String(r.emergency ?? ""),
    hire_date: String(r.hire_date ?? ""), leave_date: (r.leave_date as string) || null, leave_reason: String(r.leave_reason ?? ""),
    dept: String(r.dept ?? ""), position: String(r.position ?? ""), job: String(r.job ?? ""), emp_type: String(r.emp_type ?? ""),
    contract_start: (r.contract_start as string) || null, contract_end: (r.contract_end as string) || null, career: String(r.career ?? ""),
    pay_type: r.pay_type === "monthly" ? "monthly" : "hourly",
    work_days: Array.isArray(r.work_days) ? (r.work_days as unknown[]).map(Number) : [],
    work_start: String(r.work_start ?? ""), work_end: String(r.work_end ?? ""), break_min: num(r.break_min), daily_hours: num(r.daily_hours),
    dependents: num(r.dependents), children: num(r.children), tax_rate: ([80, 100, 120].includes(num(r.tax_rate)) ? num(r.tax_rate) : 100) as Employee["tax_rate"],
    ins_pension: !!r.ins_pension, ins_health: !!r.ins_health, ins_employment: !!r.ins_employment,
    ins_basis: r.ins_basis === "actual" ? "actual" : "notice", pension_base: num(r.pension_base), health_base: num(r.health_base),
    bank: String(r.bank ?? ""), account_no: String(r.account_no ?? ""), account_holder: String(r.account_holder ?? ""),
    leave_basis: r.leave_basis === "hire" || r.leave_basis === "fiscal" ? r.leave_basis : "", memo: String(r.memo ?? ""),
    wages, updated_at: r.updated_at ? String(r.updated_at) : undefined,
  };
}

export function toWage(r: Row): Wage {
  return { id: String(r.id), effective_from: String(r.effective_from), hourly_wage: num(r.hourly_wage), monthly_wage: num(r.monthly_wage), note: String(r.note ?? "") };
}

// 직원들의 임금 이력을 한 번에 읽어 직원별로 묶는다(적용 시작일 내림차순)
export async function wagesOf(ids: string[]): Promise<Map<string, Wage[]>> {
  const out = new Map<string, Wage[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await hrDb().from("wages").select("id,employee_id,effective_from,hourly_wage,monthly_wage,note")
      .in("employee_id", ids.slice(i, i + 200)).order("effective_from", { ascending: false });
    if (error) throw error;
    for (const r of (data || []) as Row[]) {
      const k = String(r.employee_id);
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(toWage(r));
    }
  }
  return out;
}

// ── 입력 검증 ───────────────────────────────────────────────────────
// 화면이 보낸 값 → DB 줄. 오류는 칸 이름별 문장(폼이 칸 아래에 그대로 보여 준다).
//  partial=true(수정)면 보낸 칸만 다룬다.
export type EmployeeInput = {
  row: Row;
  errors: Record<string, string>;
  rrn?: { digits: string; warn: boolean } | null;   // undefined = 건드리지 않음, null = 지움
  wage?: { effective_from: string; hourly_wage: number; monthly_wage: number; note: string };
};

const TEXT_FIELDS: [string, number][] = [
  ["emp_no", 30], ["name", 60], ["affiliation", 40], ["address", 300], ["phone", 40], ["emergency", 100], ["leave_reason", 300],
  ["dept", 60], ["position", 60], ["job", 100], ["career", 4000], ["bank", 40], ["account_no", 60], ["account_holder", 60], ["memo", 4000],
];
const DATE_FIELDS: [string, boolean, string][] = [   // [칸, 필수, 이름]
  ["hire_date", true, "입사일"], ["leave_date", false, "퇴사일"], ["contract_start", false, "계약 시작일"], ["contract_end", false, "계약 종료일"],
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function intIn(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function parseEmployeeInput(body: Row, partial: boolean): EmployeeInput {
  const row: Row = {};
  const errors: Record<string, string> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  for (const [k, max] of TEXT_FIELDS) {
    if (!has(k)) continue;
    const v = String(body[k] ?? "").trim();
    if (v.length > max) errors[k] = `${max}자 이하`;
    else row[k] = v;
  }
  if ((!partial || has("name")) && !String(body.name ?? "").trim()) errors.name = "성명을 입력하세요";

  if (!partial || has("workplace_id")) {
    const v = String(body.workplace_id ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(v)) errors.workplace_id = "사업장을 고르세요";
    else row.workplace_id = v;
  }

  for (const [k, required, label] of DATE_FIELDS) {
    if (partial && !has(k)) continue;
    const v = String(body[k] ?? "").trim();
    if (!v) { if (required) errors[k] = `${label}을 입력하세요`; else if (has(k)) row[k] = null; continue; }
    if (!isDate(v)) errors[k] = "날짜 형식이 아닙니다";
    else row[k] = v;
  }
  const hire = (row.hire_date as string) || "";
  if (hire && typeof row.leave_date === "string" && row.leave_date < hire) errors.leave_date = "퇴사일이 입사일보다 앞입니다";
  if (typeof row.contract_start === "string" && typeof row.contract_end === "string" && row.contract_end < row.contract_start) {
    errors.contract_end = "종료일이 시작일보다 앞입니다";
  }

  if (has("emp_type")) {
    const v = String(body.emp_type ?? "").trim();
    row.emp_type = (EMP_TYPES as readonly string[]).includes(v) ? v : "기타";
  }
  if (has("pay_type")) row.pay_type = body.pay_type === "monthly" ? "monthly" : "hourly";

  if (has("work_days")) {
    const days = Array.isArray(body.work_days) ? [...new Set((body.work_days as unknown[]).map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort() : [];
    row.work_days = days;
  }
  for (const k of ["work_start", "work_end"]) {
    if (!has(k)) continue;
    const v = String(body[k] ?? "").trim();
    if (!TIME_RE.test(v)) errors[k] = "시각은 09:00 형식";
    else row[k] = v;
  }
  if (has("break_min")) {
    const n = intIn(body.break_min, 0, 600);
    if (n == null) errors.break_min = "0~600 사이 숫자";
    else row.break_min = n;
  }
  if (has("daily_hours")) {
    const n = Number(body.daily_hours);
    if (!Number.isFinite(n) || n <= 0 || n > 24) errors.daily_hours = "0보다 크고 24 이하";
    else row.daily_hours = Math.round(n * 100) / 100;
  }
  if (has("dependents")) {
    const n = intIn(body.dependents, 1, 11);
    if (n == null) errors.dependents = "1~11 사이 숫자(본인 포함)";
    else row.dependents = n;
  }
  if (has("children")) {
    const n = intIn(body.children, 0, 20);
    if (n == null) errors.children = "0 이상 숫자";
    else row.children = n;
  }
  if (has("tax_rate")) {
    const n = Number(body.tax_rate);
    row.tax_rate = n === 80 || n === 120 ? n : 100;
  }
  for (const k of ["ins_pension", "ins_health", "ins_employment", "foreigner"]) {
    if (k === "foreigner") continue; // 외국인 여부는 번호에서만 정한다
    if (has(k)) row[k] = !!body[k];
  }
  if (has("ins_basis")) row.ins_basis = body.ins_basis === "actual" ? "actual" : "notice";
  for (const [k, label] of [["pension_base", "기준소득월액"], ["health_base", "보수월액"]] as const) {
    if (!has(k)) continue;
    const n = intIn(body[k] === "" || body[k] == null ? 0 : body[k], 0, 2_000_000_000);
    if (n == null) errors[k] = `${label}은 0 이상 숫자`;
    else row[k] = n;
  }
  if (has("leave_basis")) row.leave_basis = body.leave_basis === "hire" || body.leave_basis === "fiscal" ? body.leave_basis : "";

  // 주민등록번호: 빈 문자열은 "건드리지 않음"(수정 창은 번호 칸을 비워 둔 채 연다). 지우려면 rrn_clear.
  let rrn: EmployeeInput["rrn"];
  if (body.rrn_clear === true) rrn = null;
  else if (typeof body.rrn === "string" && body.rrn.trim()) {
    const p = parseRrn(body.rrn);
    if (!p.ok) errors.rrn = p.error;
    else {
      rrn = { digits: p.info.digits, warn: !p.info.checksumOk };
      row.birth_date = p.info.birth;
      row.gender = p.info.gender;
      row.foreigner = p.info.foreigner;
    }
  }

  // 임금: 금액 칸이 왔을 때만. 적용 시작일을 비우면 입사일(등록)로.
  let wage: EmployeeInput["wage"];
  if (has("hourly_wage") || has("monthly_wage")) {
    const h = intIn(body.hourly_wage === "" || body.hourly_wage == null ? 0 : body.hourly_wage, 0, 100_000_000);
    const m = intIn(body.monthly_wage === "" || body.monthly_wage == null ? 0 : body.monthly_wage, 0, 2_000_000_000);
    const from = String(body.wage_from ?? "").trim() || hire;
    if (h == null) errors.hourly_wage = "시급은 0 이상 숫자";
    if (m == null) errors.monthly_wage = "월급은 0 이상 숫자";
    if (!isDate(from)) errors.wage_from = "적용 시작일을 입력하세요";
    if (h != null && m != null && isDate(from)) wage = { effective_from: from, hourly_wage: h, monthly_wage: m, note: String(body.wage_note ?? "").trim().slice(0, 200) };
  }

  return { row, errors, rrn, wage };
}

// 주민등록번호를 DB 줄에 싣는다(암호문·비교값·가림 표기). 평문은 줄에 넣지 않는다.
export function applyRrn(row: Row, rrn: EmployeeInput["rrn"]): void {
  if (rrn === undefined) return;
  if (rrn === null) {
    Object.assign(row, { rrn_enc: null, rrn_hash: null, rrn_masked: "", birth_date: null, gender: "", foreigner: false });
    return;
  }
  row.rrn_enc = encryptRrn(rrn.digits);
  row.rrn_hash = rrnHash(rrn.digits);
  row.rrn_masked = maskRrn(rrn.digits);
}

// 같은 사업장에 같은 번호가 이미 있는가 → 그 직원 이름
export async function rrnOwner(workplaceId: string, digits: string, exceptId?: string): Promise<string | null> {
  const { data, error } = await hrDb().from("employees").select("id,name").eq("workplace_id", workplaceId).eq("rrn_hash", rrnHash(digits));
  if (error) throw error;
  const hit = ((data || []) as { id: string; name: string }[]).find((r) => r.id !== exceptId);
  return hit ? hit.name : null;
}
