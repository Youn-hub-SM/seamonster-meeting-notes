// 엑셀 올리기(인사대장·근무대장) — 서버 전용: 파일 읽기, 저장된 것과 대조, 저장. 화면에서 import 하지 말 것.
//
//  두 단계다: plan*(파일 → 무엇을 할지) 과 apply*(그대로 저장). 미리보기와 등록이 같은 plan 을 쓴다 —
//  등록할 때도 파일을 다시 읽어 다시 대조하므로, 화면이 보낸 '미리보기 결과'를 믿고 저장하는 길이 없다.
//  검증은 화면 입력과 같은 함수(parseEmployeeInput·normalizeLog)로 한다. 주민등록번호는 암호화해서만 저장하고,
//  평문은 이 요청을 처리하는 동안 메모리에만 있다(응답·이력·로그에 싣지 않는다).

import ExcelJS from "exceljs";
import { hrAudit, hrDb } from "./hr-db";
import { dataKeyReady, rrnHash } from "./hr-crypto";
import { applyRrn, missingAffiliation, parseEmployeeInput, readEmployees, wagesOf, writeEmployee, type DbResult, type EmployeeInput } from "./hr-employees";
import { currentWage, numText, type Wage } from "./hr";
import { fetchLogs, fetchRoster } from "./hr-work-db";
import { monthRange, normalizeLog, type RosterEmployee, type WorkLog } from "./hr-work";
import { confirmedWorkplaces } from "./hr-pay-db";
import {
  EMP_KEY_LABEL, dailyHoursOf, readEmployeeSheet, readWorkSheet, sameWorkLog,
  type Cell, type EmpSheet, type ImportAction, type ImportLine, type ImportReport, type Sheet, type WorkRow,
} from "./hr-import";

type Row = Record<string, unknown>;
export const IMPORT_MAX_BYTES = 3 * 1024 * 1024;
const MAX_ROWS = 6000, MAX_COLS = 80, MAX_EMPLOYEES = 1000, MAX_LINES = 300;

// ── 파일 읽기 ───────────────────────────────────────────────────────
// 엑셀 칸 값 → 글자·숫자·날짜. 수식은 결과만, 서식 있는 글자·링크는 글자만 꺼낸다.
function plain(v: unknown): Cell {
  if (v == null) return null;
  if (v instanceof Date || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Row;
    if ("result" in o) return plain(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text || "").join("");
    if ("text" in o) return plain(o.text);
  }
  return null; // 결과 없는 수식·오류 칸
}
// base64 .xlsx → 시트들. 읽지 못하면 던진다(문장 그대로 화면에 보인다).
export async function loadSheets(b64: string): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(b64, "base64") as unknown as ArrayBuffer);
  } catch {
    throw new ImportError("엑셀 파일(.xlsx)을 읽지 못했습니다.");
  }
  const out: Sheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.rowCount > MAX_ROWS) throw new ImportError(`줄이 너무 많습니다(시트 한 장에 ${numText(MAX_ROWS)}줄까지).`);
    const grid: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const line: Cell[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => { if (col <= MAX_COLS) line[col - 1] = plain(cell.value); });
      for (let j = 0; j < line.length; j++) if (line[j] === undefined) line[j] = null;
      grid[n - 1] = line;
    });
    for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
    out.push({ name: ws.name, grid });
  });
  return out;
}
// 사용자에게 그대로 보일 오류(파일이 틀렸을 때). 그 밖의 오류는 DB 오류로 다룬다.
export class ImportError extends Error {}
// 올린 파일(이름·base64)을 읽기 전에 본다 → 문제가 있으면 문장, 없으면 ""
export function uploadProblem(name: string, b64: string): string {
  if (!b64) return "엑셀 파일을 고르세요.";
  if (b64.length > IMPORT_MAX_BYTES * 1.4) return "파일이 너무 큽니다(3MB 이하).";
  if (/\.xls$/i.test(name)) return "옛 엑셀 형식(.xls)은 읽지 못합니다. 엑셀에서 .xlsx 로 다시 저장해 올리세요.";
  if (/\.csv$/i.test(name)) return "CSV 는 읽지 못합니다. 엑셀에서 .xlsx 로 저장해 올리세요.";
  return "";
}

const emptyCounts = (): Record<ImportAction, number> => ({ create: 0, update: 0, same: 0, error: 0 });
const order: Record<ImportAction, number> = { error: 0, create: 1, update: 2, same: 3 };

// ── 인사대장 ────────────────────────────────────────────────────────
type Old = Row & { id: string; workplace_id: string; name: string; emp_no: string; hire_date: string; rrn_hash: string | null };
type EmpPlanRow = {
  line: number; action: ImportAction; name: string; who: string;
  notes: string[]; errors: string[]; warns: string[];
  id?: string;                                   // 고칠 직원
  row: Row;                                      // 새 직원 = 넣을 칸 전부, 고침 = 바뀐 칸만
  rrn?: { digits: string; warn: boolean };       // 넣거나 바꿀 번호(메모리에만)
  wage?: NonNullable<EmployeeInput["wage"]>;
  changed?: Row;                                 // 이력용(값까지 남기지 않는 칸은 "변경")
};
export type EmpPlan = { rows: EmpPlanRow[]; notes: string[] };

// 이력에 값까지 남기지 않는 칸(app/api/hr/employees/[id]/route.ts 와 같다)
const QUIET = new Set(["account_no"]);
const NUM_KEYS = new Set(["break_min", "daily_hours", "dependents", "children", "tax_rate", "pension_base", "health_base"]);
function sameValue(key: string, a: unknown, b: unknown): boolean {
  const canon = (x: unknown): string => {
    if (x == null || x === "") return "";
    if (Array.isArray(x)) return JSON.stringify(x.map(Number).sort((p, q) => p - q));
    if (NUM_KEYS.has(key)) return String(Number(x));
    return typeof x === "boolean" ? String(x) : String(x);
  };
  return canon(a) === canon(b);
}
const squash = (s: unknown) => String(s ?? "").replace(/\s/g, "");
// 검증 오류(칸 이름 → 문장)를 화면 문장으로. 이미 그 칸을 읽다 생긴 오류가 있으면 겹쳐 말하지 않는다
//  (입사일을 읽지 못했는데 '입사일을 입력하세요'·'적용 시작일을 입력하세요'까지 붙지 않게).
function fieldErrors(errors: Record<string, string>, already: string[], skip: string[] = []): string[] {
  const said = (k: string) => already.some((e) => e.startsWith(`${EMP_KEY_LABEL[k] || k}:`));
  return Object.entries(errors)
    .filter(([k]) => !skip.includes(k) && !said(k) && !(k === "wage_from" && (said("hire_date") || "hire_date" in errors)))
    .map(([k, m]) => `${EMP_KEY_LABEL[k] || k}: ${m}`);
}

async function allEmployees(): Promise<Old[]> {
  const out: Old[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await readEmployees((cols) => hrDb().from("employees").select(cols).order("hire_date").order("id").range(offset, offset + 999), "rrn_hash");
    if (error) throw error;
    const rows = (data || []) as unknown as Row[];
    for (const r of rows) out.push({ ...r, id: String(r.id), workplace_id: String(r.workplace_id), name: String(r.name ?? ""), emp_no: String(r.emp_no ?? ""), hire_date: String(r.hire_date ?? ""), rrn_hash: (r.rrn_hash as string) || null });
    if (rows.length < 1000) break;
  }
  return out;
}

// 파일 → 줄마다 무엇을 할지. defaultWorkplaceId = 사업장 칸이 빈 줄에 쓸 사업장(없으면 사업장이 하나일 때 그 사업장).
export async function planEmployees(sheets: Sheet[], defaultWorkplaceId: string): Promise<EmpPlan> {
  let sheet: EmpSheet | null = null;
  for (const s of sheets) { const r = readEmployeeSheet(s.grid); if (r && (!sheet || r.hits > sheet.hits)) sheet = r; }
  if (!sheet) throw new ImportError("'성명' 칸이 있는 머리 줄을 찾지 못했습니다. [양식 내려받기]로 받은 양식을 쓰세요.");
  if (sheet.rows.length === 0) throw new ImportError("머리 줄 아래에 직원이 한 줄도 없습니다.");
  if (sheet.rows.length > MAX_EMPLOYEES) throw new ImportError(`한 번에 ${numText(MAX_EMPLOYEES)}명까지 올릴 수 있습니다.`);

  // 소속 목록은 '목록에 없는 이름' 경고에만 쓴다 — 소속 칸(hr/006)이 아직 없으면 목록 없이 읽는다
  let wpRes: DbResult = await hrDb().from("workplaces").select("id,name,affiliations").order("sort").order("created_at");
  if (wpRes.error && missingAffiliation(wpRes.error)) wpRes = await hrDb().from("workplaces").select("id,name").order("sort").order("created_at");
  if (wpRes.error) throw wpRes.error;
  const workplaces = (wpRes.data || []) as { id: string; name: string; affiliations?: string[] }[];
  const affOf = new Map(workplaces.map((w) => [w.id, Array.isArray(w.affiliations) ? w.affiliations.map(String) : []]));
  const wpByName = new Map(workplaces.map((w) => [squash(w.name), w.id]));
  const wpName = new Map(workplaces.map((w) => [w.id, w.name]));
  const fallbackWp = workplaces.some((w) => w.id === defaultWorkplaceId) ? defaultWorkplaceId : workplaces.length === 1 ? workplaces[0].id : "";
  const olds = await allEmployees();
  const wages = await wagesOf(olds.map((o) => o.id));
  const keyReady = dataKeyReady();

  const seenOld = new Map<string, number>(), seenNew = new Map<string, number>();
  const rows: EmpPlanRow[] = [];
  for (const r of sheet.rows) {
    const v = r.values;
    const errors = [...r.errors], warns: string[] = [], notes: string[] = [];
    const name = String(v.name ?? "").trim(), empNo = String(v.emp_no ?? "").trim();
    const hire = typeof v.hire_date === "string" ? v.hire_date : "";

    let wpId = "";
    if (v.workplace) {
      wpId = wpByName.get(squash(v.workplace)) || "";
      if (!wpId) errors.push(`사업장: 등록되지 않은 이름입니다(${String(v.workplace).slice(0, 30)})`);
    } else if (!(wpId = fallbackWp)) errors.push("사업장: 비어 있습니다");

    // 소속: 사업장의 소속 목록에 없는 이름이면 넣기는 하되 알려 준다(오타로 소속이 하나 더 생기는 것을 눈에 띄게)
    if (typeof v.affiliation === "string" && wpId && !(affOf.get(wpId) || []).includes(v.affiliation)) {
      warns.push(`소속: 사업장의 소속 목록에 없는 이름입니다(${v.affiliation.slice(0, 30)})`);
    }

    const digits = typeof v.rrn === "string" ? v.rrn : "";
    if (digits && !keyReady) errors.push("주민등록번호: 암호화 키(HR_DATA_KEY)가 서버에 없어 저장할 수 없습니다");
    const hash = digits && keyReady ? rrnHash(digits) : "";

    // 이미 있는 직원인가 — 주민등록번호 → 사번 → (성명 + 입사일) 순으로 같은 사업장에서 찾는다
    let old: Old | null = null;
    if (wpId) {
      const mine = olds.filter((o) => o.workplace_id === wpId);
      const byRrn = hash ? mine.find((o) => o.rrn_hash === hash) || null : null;
      const byNo = empNo ? mine.find((o) => o.emp_no === empNo) || null : null;
      if (byRrn && byNo && byRrn.id !== byNo.id) errors.push(`주민등록번호와 사번이 서로 다른 직원을 가리킵니다(${byRrn.name}, ${byNo.name})`);
      else if (!byRrn && byNo && name && byNo.name !== name) errors.push(`사번: ${empNo} 은 다른 직원(${byNo.name})이 쓰고 있습니다`);
      old = byRrn || byNo;
      if (!old && name) {
        const same = mine.filter((o) => o.name === name);
        if (hire) {
          old = same.find((o) => o.hire_date === hire) || null;
          if (!old && same.length > 0) warns.push(`같은 이름의 직원이 있습니다(입사일 ${same.map((o) => o.hire_date).join(", ")}). 다른 사람으로 보고 새로 등록합니다`);
        } else if (same.length === 1) old = same[0];
        else if (same.length > 1) errors.push("같은 이름의 직원이 둘 이상입니다. 사번이나 주민등록번호를 넣으세요");
      }
    }
    const who = `${name || old?.name || "(이름 없음)"}${empNo || old?.emp_no ? ` (${empNo || old?.emp_no})` : ""}`;
    const base = { line: r.line, name: name || old?.name || "", who, notes, errors, warns };

    if (old) {
      const dup = seenOld.get(old.id);
      if (dup) errors.push(`같은 직원이 ${dup}줄에도 있습니다`);
      const body: Row = { ...v };
      for (const k of ["workplace", "rrn", "hourly_wage", "monthly_wage", "wage_from"]) delete body[k];
      const rrnNew = !!hash && old.rrn_hash !== hash;
      if (rrnNew) body.rrn = digits;
      const input = parseEmployeeInput(body, true);
      const hireNow = String(input.row.hire_date ?? old.hire_date ?? "");
      const leaveNow = "leave_date" in input.row ? input.row.leave_date : old.leave_date;
      if (typeof leaveNow === "string" && leaveNow && hireNow && leaveNow < hireNow) input.errors.leave_date = "퇴사일이 입사일보다 앞입니다";
      errors.push(...fieldErrors(input.errors, errors));
      if (input.rrn?.warn) warns.push("주민등록번호의 검증 숫자가 맞지 않습니다. 번호를 다시 확인하세요");

      const row: Row = {}, changed: Row = {}, labels: string[] = [];
      for (const [k, val] of Object.entries(input.row)) {
        if (k === "birth_date" || k === "gender" || k === "foreigner") { if (rrnNew) row[k] = val; continue; } // 번호에 딸린 칸
        if (sameValue(k, old[k], val)) continue;
        row[k] = val; labels.push(EMP_KEY_LABEL[k] || k);
        changed[k] = QUIET.has(k) ? "변경" : [old[k] ?? null, val ?? null];
      }
      if (rrnNew) { labels.push("주민등록번호"); changed.rrn = "변경"; }

      // 임금: 금액이 지금과 다를 때만, 그리고 '임금 적용 시작일'이 있을 때만 고친다(언제부터인지 모르는 인상은 넣지 않는다)
      let wage: EmpPlanRow["wage"];
      if (v.hourly_wage != null || v.monthly_wage != null) {
        const cur = currentWage(wages.get(old.id) || ([] as Wage[]));
        const h = Number(v.hourly_wage ?? cur?.hourly_wage ?? 0), m = Number(v.monthly_wage ?? cur?.monthly_wage ?? 0);
        if (h < 0 || h > 100_000_000) errors.push("시급: 0 이상 숫자");
        else if (m < 0 || m > 2_000_000_000) errors.push("월급: 0 이상 숫자");
        else if (!cur || cur.hourly_wage !== h || cur.monthly_wage !== m) {
          if (typeof v.wage_from === "string") {
            wage = { effective_from: v.wage_from, hourly_wage: h, monthly_wage: m, note: "" }; labels.push("임금"); changed.wage = wage;
            // 내려받은 파일에서 금액만 바꾸면 날짜가 지금 줄과 같다 — 인상이 아니라 그 날짜부터의 금액을 통째로 바꾸는 것
            if (cur && cur.effective_from === v.wage_from) warns.push(`임금 적용 시작일이 지금 줄(${cur.effective_from})과 같아 그날부터의 금액이 바뀝니다. 인상이면 인상한 날을 넣으세요`);
          } else warns.push("임금이 지금과 다릅니다. '임금 적용 시작일'을 넣어야 고쳐집니다");
        }
      }
      if (labels.length > 0) notes.push(`바뀌는 칸: ${labels.join(", ")}`);
      if (errors.length === 0) seenOld.set(old.id, r.line);   // 오류 난 줄은 '먼저 나온 줄'로 치지 않는다
      rows.push({ ...base, action: errors.length ? "error" : labels.length ? "update" : "same", id: old.id, row, rrn: rrnNew ? input.rrn || undefined : undefined, wage, changed });
      continue;
    }

    // 새 직원
    for (const [key, label] of [[`no|${wpId}|${empNo}`, "사번"], [`rrn|${wpId}|${hash}`, "주민등록번호"], [`name|${wpId}|${name}|${hire}`, "성명과 입사일"]] as const) {
      if (key.endsWith("|") || (label === "성명과 입사일" && (!name || !hire))) continue;
      const dup = seenNew.get(key);
      if (dup) { errors.push(`같은 ${label}이 ${dup}줄에도 있습니다`); break; }
      seenNew.set(key, r.line);
    }
    // 다른 사업장에 같은 사람이 있으면 알려 준다(사업장 칸 없이 여러 사업장 직원을 섞어 올려 같은 사람이 두 번 생기는 것을 막으려고)
    const elsewhere = olds.find((o) => o.workplace_id !== wpId && ((!!hash && o.rrn_hash === hash) || (!!name && !!hire && o.name === name && o.hire_date === hire)));
    if (elsewhere) warns.push(`다른 사업장(${wpName.get(elsewhere.workplace_id) || ""})에 같은 사람이 있습니다. 그 직원을 고치려면 사업장 칸에 그 사업장 이름을 넣으세요`);
    const body: Row = { ...v, workplace_id: wpId };
    delete body.workplace; delete body.rrn;
    if (digits) body.rrn = digits;
    if (!body.pay_type) body.pay_type = Number(v.monthly_wage) > 0 && !(Number(v.hourly_wage) > 0) ? "monthly" : "hourly";
    body.hourly_wage = v.hourly_wage ?? 0; body.monthly_wage = v.monthly_wage ?? 0;
    if (body.pay_type === "hourly" && !(Number(body.hourly_wage) > 0)) errors.push("시급: 비어 있습니다");
    if (body.pay_type === "monthly" && !(Number(body.monthly_wage) > 0)) errors.push("월급: 비어 있습니다");
    if (body.daily_hours == null && (body.work_start || body.work_end || body.break_min != null)) {
      const h = dailyHoursOf(String(body.work_start || "09:00"), String(body.work_end || "18:00"), Number(body.break_min ?? 60));
      if (h) body.daily_hours = h;
    }
    const input = parseEmployeeInput(body, false);
    errors.push(...fieldErrors(input.errors, errors, wpId ? [] : ["workplace_id"]));
    if (input.rrn?.warn) warns.push("주민등록번호의 검증 숫자가 맞지 않습니다. 번호를 다시 확인하세요");
    notes.push([wpName.get(wpId) || "", hire ? `입사 ${hire}` : "", input.wage ? (body.pay_type === "monthly" ? `월급 ${numText(input.wage.monthly_wage)}원` : `시급 ${numText(input.wage.hourly_wage)}원`) : ""].filter(Boolean).join(" · "));
    rows.push({ ...base, action: errors.length ? "error" : "create", row: input.row, rrn: input.rrn || undefined, wage: input.wage });
  }

  const planNotes: string[] = [];
  if (sheet.unknown.length > 0) planNotes.push(`읽지 않은 칸: ${sheet.unknown.slice(0, 12).join(", ")}`);
  planNotes.push("빈 칸과 가려진 주민등록번호는 건드리지 않습니다.");
  return { rows, notes: planNotes };
}

const dbMsg = (m: string): string => (/employees_emp_no_uq/.test(m) ? "이미 쓰는 사번입니다" : /employees_rrn_uq/.test(m) ? "이미 등록된 주민등록번호입니다" : m || "저장하지 못했습니다");

// plan 대로 저장한다. 한 줄이 실패해도 나머지는 계속한다 — 실패한 줄은 failed 로 돌려준다.
export async function applyEmployees(plan: EmpPlan, actor: string, ip: string, file: string): Promise<{ created: number; updated: number; failed: string[] }> {
  let created = 0, updated = 0;
  const failed: string[] = [];
  for (const p of plan.rows) {
    try {
      if (p.action === "create") {
        const row: Row = { ...p.row, created_by: actor, updated_by: actor };
        applyRrn(row, p.rrn);
        const ins = await writeEmployee(row, (r) => hrDb().from("employees").insert(r).select("id").single());
        if (ins.error) throw ins.error;
        const id = String((ins.data as Row).id);
        const w = await hrDb().from("wages").insert({ employee_id: id, ...p.wage, created_by: actor });
        if (w.error) { await hrDb().from("employees").delete().eq("id", id); throw w.error; } // 임금 줄 없는 직원이 남지 않게
        await hrAudit({ actor, action: "employee_create", ip, targetType: "employee", targetId: id, targetName: p.name, detail: { rrn: p.rrn ? "입력" : "없음", via: "excel" } });
        created++;
      } else if (p.action === "update" && p.id) {
        const row: Row = { ...p.row };
        applyRrn(row, p.rrn);
        if (Object.keys(row).length > 0) {
          const id = p.id;
          const { error } = await writeEmployee(row, (r) => hrDb().from("employees").update({ ...r, updated_by: actor, updated_at: new Date().toISOString() }).eq("id", id));
          if (error) throw error;
        }
        if (p.wage) {
          const { error } = await hrDb().from("wages").upsert({ employee_id: p.id, ...p.wage, created_by: actor }, { onConflict: "employee_id,effective_from" });
          if (error) throw error;
        }
        await hrAudit({ actor, action: "employee_update", ip, targetType: "employee", targetId: p.id, targetName: p.name, detail: { changed: p.changed || {}, via: "excel" } });
        updated++;
      }
    } catch (err) {
      failed.push(`${p.line}줄 ${p.who}: ${dbMsg(String((err as { message?: string })?.message || ""))}`);
    }
  }
  await hrAudit({ actor, action: "employee_import", ip, targetType: "employee", targetName: `${created + updated}명`, detail: { file, created, updated, failed: failed.length } });
  return { created, updated, failed };
}

export function employeeReport(plan: EmpPlan, done?: { failed: string[] }): ImportReport {
  const counts = emptyCounts();
  const lines: ImportLine[] = plan.rows.map((p) => {
    counts[p.action]++;
    return { at: `${p.line}줄`, who: p.who, action: p.action, notes: p.notes, errors: p.errors, warns: p.warns };
  }).sort((a, b) => order[a.action] - order[b.action]);
  return { applied: !!done, counts, lines, notes: plan.notes, failed: done?.failed || [] };
}

// ── 근무대장 ────────────────────────────────────────────────────────
type WorkPlanEmp = { e: RosterEmployee; add: number; change: number; same: number; rows: WorkLog[] }; // rows = 그 달 전체(저장된 것 위에 올린 것을 덮은 것)
export type WorkPlan = { month: string; emps: WorkPlanEmp[]; errors: ImportLine[]; errorCount: number; notes: string[] };
const whoOf = (e: { name: string; emp_no: string }) => `${e.name}${e.emp_no ? ` (${e.emp_no})` : ""}`;

// 파일 → 직원마다 그 달에 넣을 줄. 파일에 있는 날짜만 넣거나 고친다(없는 날·빈 줄은 저장된 그대로 둔다).
export async function planWork(sheets: Sheet[], month: string): Promise<WorkPlan> {
  const read: WorkRow[] = [];
  let matched = 0;
  for (const s of sheets) { const r = readWorkSheet(s); if (r) { matched++; read.push(...r); } }
  if (matched === 0) throw new ImportError("'날짜' 칸이 있는 머리 줄을 찾지 못했습니다. [이 달 양식 내려받기]로 받은 파일을 쓰세요.");

  const { from, to } = monthRange(month);
  const roster = await fetchRoster(month);
  const locked = new Set(await confirmedWorkplaces(month));
  const saved = new Map<string, WorkLog>();
  for (const l of await fetchLogs(month, roster.map((e) => e.id))) {
    if (l.work_date < from || l.work_date > to) continue;
    const { employee_id, ...log } = l;
    saved.set(`${employee_id}|${l.work_date}`, log);
  }

  // 사번·성명 → 직원(그 달에 재직한 사람 가운데)
  const found = new Map<string, RosterEmployee | string>();
  const resolve = (empNo: string, name: string): RosterEmployee | string => {
    const key = `${empNo}|${name}`;
    const hit = found.get(key);
    if (hit) return hit;
    let out: RosterEmployee | string;
    if (!empNo && !name) out = "누구의 줄인지 알 수 없습니다(사번·성명이 없습니다)";
    else if (empNo) {
      let by = roster.filter((e) => e.emp_no === empNo);
      if (by.length > 1 && name) by = by.filter((e) => e.name === name);
      out = by.length === 0 ? `이 달에 재직한 직원이 아닙니다(사번 ${empNo})`
        : by.length > 1 ? `사번 ${empNo} 인 직원이 둘 이상입니다. 성명 칸을 넣으세요`
        : name && by[0].name !== name && !by[0].name.startsWith(name) ? `사번 ${empNo} 의 이름이 다릅니다(파일 ${name}, 인사대장 ${by[0].name})`
        : by[0];
    } else {
      const by = roster.filter((e) => e.name === name);
      out = by.length === 0 ? `이 달에 재직한 직원이 아닙니다(${name})` : by.length > 1 ? `${name} 직원이 둘 이상입니다. 사번 칸을 넣으세요` : by[0];
    }
    found.set(key, out);
    return out;
  };

  const errors: ImportLine[] = [];
  const grouped = new Map<string, ImportLine & { n: number }>();   // 같은 이유가 여러 줄이면 한 줄로 묶는다
  let errorCount = 0;
  const fail = (at: string, who: string, msg: string, groupKey?: string) => {
    errorCount++;
    if (groupKey) {
      const g = grouped.get(groupKey);
      if (g) { g.n++; g.notes = [`${g.n}줄`]; return; }
      const line = { at, who, action: "error" as const, notes: [], errors: [msg], warns: [], n: 1 };
      grouped.set(groupKey, line); errors.push(line);
      return;
    }
    errors.push({ at, who, action: "error", notes: [], errors: [msg], warns: [] });
  };

  const emps = new Map<string, WorkPlanEmp & { fresh: Map<string, WorkLog> }>();
  let otherMonth = 0, breakFilled = 0;
  for (const r of read) {
    const at = `${r.sheet} ${r.line}줄`, label = whoOf(r);
    if (r.error) { fail(at, label, r.error); continue; }
    if (r.date < from || r.date > to) { otherMonth++; continue; }
    if (!r.raw) continue;                                                      // 내용이 없는 줄
    const e = resolve(r.emp_no, r.name);
    if (typeof e === "string") { fail(r.sheet, label, e, `who|${r.sheet}|${r.emp_no}|${r.name}`); continue; }
    if (locked.has(e.workplace_id)) { fail(r.sheet, whoOf(e), "급여가 확정된 달입니다. 근무대장을 고치려면 급여 확정을 취소하세요", `lock|${e.id}`); continue; }
    if (r.date < e.hire_date) { fail(at, whoOf(e), `${r.date} 입사 전 날짜입니다`); continue; }
    if (e.leave_date && r.date > e.leave_date) { fail(at, whoOf(e), `${r.date} 퇴사 뒤 날짜입니다`); continue; }
    let plan = emps.get(e.id);
    if (!plan) emps.set(e.id, plan = { e, add: 0, change: 0, same: 0, rows: [], fresh: new Map() });
    if (plan.fresh.has(r.date)) { fail(at, whoOf(e), `${r.date} 이 파일에 두 번 있습니다`); continue; }

    const old = saved.get(`${e.id}|${r.date}`);
    const raw = r.raw, timed = !!raw.start_time || !!raw.end_time;
    const sameTimes = !!old && (old.start_time || "") === (raw.start_time || "") && (old.end_time || "") === (raw.end_time || "");
    // 휴게를 비운 날: 저장된 줄과 출퇴근이 같으면 그 휴게를, 아니면 직원 정보의 평소 휴게를 넣는다
    let breakMin = raw.break_min;
    if (breakMin == null) { breakMin = timed ? (sameTimes ? old!.break_min : e.break_min) : 0; if (timed && !sameTimes) breakFilled++; }
    // 야간을 비운 날: 출퇴근·휴게가 저장된 줄과 같으면 손으로 고쳐 둔 야간을 지키고, 아니면 다시 계산한다
    const night = raw.night_hours ?? (sameTimes && old!.break_min === breakMin ? old!.night_hours : undefined);
    const n = normalizeLog({ ...raw, break_min: breakMin, night_hours: night as number, memo: raw.memo || old?.memo || "" });
    if (!n.ok) { fail(at, whoOf(e), `${r.date} ${n.error}`); continue; }
    plan.fresh.set(r.date, n.log);
    if (!old) plan.add++; else if (sameWorkLog(old, n.log)) plan.same++; else plan.change++;
  }

  const out: WorkPlanEmp[] = [];
  for (const p of emps.values()) {
    const all = new Map<string, WorkLog>();
    for (const [k, l] of saved) if (k.startsWith(`${p.e.id}|`)) all.set(l.work_date, l);
    for (const [d, l] of p.fresh) all.set(d, l);
    out.push({ e: p.e, add: p.add, change: p.change, same: p.same, rows: [...all.values()].sort((a, b) => a.work_date.localeCompare(b.work_date)) });
  }
  out.sort((a, b) => a.e.name.localeCompare(b.e.name, "ko"));

  const notes: string[] = ["파일에 있는 날짜만 넣거나 고칩니다. 파일에 없는 날과 내용이 빈 줄은 그대로 둡니다."];
  if (otherMonth > 0) notes.push(`${month} 밖의 날짜 ${otherMonth}줄은 넣지 않습니다.`);
  if (breakFilled > 0) notes.push(`휴게(분)를 비운 ${breakFilled}일은 직원 정보의 평소 휴게를 넣었습니다.`);
  return { month, emps: out, errors, errorCount, notes };
}

// plan 대로 저장한다 — 직원마다 한 달을 한 번에(hr.save_work_logs 한 트랜잭션). 한 사람이 실패해도 나머지는 계속한다.
export async function applyWork(plan: WorkPlan, actor: string, ip: string, file: string): Promise<{ saved: number; failed: string[] }> {
  const { from, to } = monthRange(plan.month);
  let saved = 0, days = 0;
  const failed: string[] = [];
  for (const p of plan.emps) {
    if (p.add + p.change === 0) continue;
    const { error } = await hrDb().rpc("save_work_logs", { p_employee: p.e.id, p_from: from, p_to: to, p_rows: p.rows, p_actor: actor });
    if (error) { failed.push(`${whoOf(p.e)}: ${error.message || "저장하지 못했습니다"}`); continue; }
    saved++; days += p.add + p.change;
    await hrAudit({ actor, action: "work_save", ip, targetType: "employee", targetId: p.e.id, targetName: p.e.name, detail: { month: plan.month, rows: p.rows.length, via: "excel", added: p.add, changed: p.change } });
  }
  await hrAudit({ actor, action: "work_import", ip, targetType: "work", targetName: plan.month, detail: { file, month: plan.month, employees: saved, days, failed: failed.length } });
  return { saved, failed };
}

export function workReport(plan: WorkPlan, done?: { failed: string[] }): ImportReport {
  const counts = emptyCounts();
  counts.error = plan.errorCount;
  const lines: ImportLine[] = [...plan.errors.slice(0, MAX_LINES)];
  for (const p of plan.emps) {
    counts.create += p.add; counts.update += p.change; counts.same += p.same;
    const note = [p.add ? `새로 ${p.add}일` : "", p.change ? `고침 ${p.change}일` : "", p.same ? `같음 ${p.same}일` : ""].filter(Boolean).join(" · ");
    lines.push({ at: "", who: whoOf(p.e), action: p.add ? "create" : p.change ? "update" : "same", notes: [note], errors: [], warns: [] });
  }
  const notes = [...plan.notes];
  if (plan.errors.length > MAX_LINES) notes.push(`오류는 처음 ${MAX_LINES}줄만 보입니다.`);
  return { applied: !!done, counts, lines, notes, failed: done?.failed || [] };
}
