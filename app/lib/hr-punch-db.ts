// 세콤 출근 기록 → 근무대장 — 서버 전용: 이름 짝·미리 적기·보정 기준·근무대장 확정, 파일 → 계획 → 저장. 화면에서 import 하지 말 것.
//  미리보기와 입력 완료가 같은 plan 을 쓴다 — 입력 완료 때도 파일을 다시 읽어 다시 계산하고, 화면이 보낸 것은 '처리 고르기'뿐이다.

import { hrAudit, hrDb, isHrPending } from "./hr-db";
import { isDate } from "./hr";
import { monthRange, summarizeMonth, weekdayOf, type RosterEmployee, type RosterWorkplace, type WorkLog } from "./hr-work";
import { fetchLogs, fetchRoster, fetchWorkplaces } from "./hr-work-db";
import { fetchHolidays } from "./hr-holidays-db";
import { dayOffsOf, fillKindOf } from "./hr-holidays";
import { confirmedWorkplaces } from "./hr-pay-db";
import { ImportError } from "./hr-import-db";
import { sameWorkLog, type Sheet } from "./hr-import";
import {
  NOTE_KINDS, PUNCH_DEFAULTS, cleanSettings, decisionLog, planDay, readPunchSheet,
  type NoteKind, type PunchCheck, type PunchDecision, type PunchNameRow, type PunchNote, type PunchReport, type PunchRow, type PunchSettings,
} from "./hr-punch";

type Row = Record<string, unknown>;
export const HR_PENDING_010 = "DB 준비 전입니다. supabase/migrations/hr/010_attendance.sql 을 적용하세요.";
const PAGE = 1000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── 보정 기준 ───────────────────────────────────────────────────────
export async function fetchPunchSettings(): Promise<PunchSettings> {
  const { data, error } = await hrDb().from("punch_settings").select("grace_min,overtime_min").limit(1);
  if (error) throw error;
  const r = ((data || []) as Row[])[0];
  return r ? cleanSettings(r as Partial<PunchSettings>) : { ...PUNCH_DEFAULTS };
}
export async function savePunchSettings(s: PunchSettings, actor: string): Promise<void> {
  const { error } = await hrDb().from("punch_settings").upsert({ id: true, ...s, updated_by: actor, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

// ── 이름 짝 ─────────────────────────────────────────────────────────
type NameMap = Map<string, { employee_id: string | null; skip: boolean }>;
export async function fetchNameMap(): Promise<NameMap> {
  const { data, error } = await hrDb().from("punch_names").select("source_name,employee_id,skip").limit(5000);
  if (error) throw error;
  return new Map(((data || []) as Row[]).map((r) => [String(r.source_name), { employee_id: r.employee_id ? String(r.employee_id) : null, skip: !!r.skip }]));
}
// 짝을 넣거나 고친다. employee_id 도 skip 도 없으면 그 이름의 짝을 지운다.
export async function saveNames(items: { source_name: string; employee_id: string | null; skip: boolean }[], actor: string): Promise<void> {
  const now = new Date().toISOString();
  const put = items.filter((i) => i.skip || i.employee_id).map((i) => ({ source_name: i.source_name, employee_id: i.skip ? null : i.employee_id, skip: !!i.skip, updated_by: actor, updated_at: now }));
  const drop = items.filter((i) => !i.skip && !i.employee_id).map((i) => i.source_name);
  if (put.length > 0) { const { error } = await hrDb().from("punch_names").upsert(put, { onConflict: "source_name" }); if (error) throw error; }
  if (drop.length > 0) { const { error } = await hrDb().from("punch_names").delete().in("source_name", drop); if (error) throw error; }
}

// ── 미리 적기 ───────────────────────────────────────────────────────
const toNote = (r: Row): PunchNote => ({
  id: String(r.id), employee_id: String(r.employee_id), work_date: String(r.work_date),
  kind: (NOTE_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as NoteKind) : "etc",
  in_time: (r.in_time as string) || null, out_time: (r.out_time as string) || null, memo: String(r.memo ?? ""), created_by: String(r.created_by ?? ""),
});
export async function fetchNotes(from: string, to: string): Promise<PunchNote[]> {
  const { data, error } = await hrDb().from("punch_notes").select("id,employee_id,work_date,kind,in_time,out_time,memo,created_by").gte("work_date", from).lte("work_date", to).order("work_date").limit(5000);
  if (error) throw error;
  return ((data || []) as Row[]).map(toNote);
}
export function parseNote(body: Row): { ok: true; row: Row } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const employee_id = String(body.employee_id ?? ""), work_date = String(body.work_date ?? "");
  const kind = String(body.kind ?? "both");
  const tin = String(body.in_time ?? "").trim(), tout = String(body.out_time ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(employee_id)) fields.employee_id = "직원을 고르세요";
  if (!isDate(work_date)) fields.work_date = "날짜를 입력하세요";
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) fields.kind = "내용을 고르세요";
  if (tin && !TIME.test(tin)) fields.in_time = "시각은 HH:MM";
  if (tout && !TIME.test(tout)) fields.out_time = "시각은 HH:MM";
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, row: { employee_id, work_date, kind, in_time: tin || null, out_time: tout || null, memo: String(body.memo ?? "").trim().slice(0, 200) } };
}

// ── 세콤 원본 ───────────────────────────────────────────────────────
export async function fetchPunches(employeeId: string, from: string, to: string): Promise<Record<string, { in: string | null; out: string | null }>> {
  try {
    const { data, error } = await hrDb().from("punches").select("work_date,in_time,out_time").eq("employee_id", employeeId).gte("work_date", from).lte("work_date", to).limit(100);
    if (error) throw error;
    return Object.fromEntries(((data || []) as Row[]).map((r) => [String(r.work_date), { in: (r.in_time as string) || null, out: (r.out_time as string) || null }]));
  } catch (err) {
    if (isHrPending(err)) return {};   // hr/010 전 — 원본 없이 지금까지처럼
    throw err;
  }
}

// ── 근무대장 확정 ───────────────────────────────────────────────────
export type Closing = { workplace_id: string; closed_by: string; closed_at: string };
// ready = 확정 기능이 있는가(hr/010 적용). 없으면 지금까지처럼 확정 없이 돈다.
export async function fetchClosings(month: string): Promise<{ ready: boolean; closed: Closing[] }> {
  try {
    const { data, error } = await hrDb().from("work_closings").select("workplace_id,closed_by,closed_at").eq("month", month);
    if (error) throw error;
    return { ready: true, closed: ((data || []) as Row[]).map((r) => ({ workplace_id: String(r.workplace_id), closed_by: String(r.closed_by ?? ""), closed_at: String(r.closed_at ?? "") })) };
  } catch (err) {
    if (isHrPending(err)) return { ready: false, closed: [] };
    throw err;
  }
}
// 급여를 저장·확정해도 되는가: 확정 기능이 없으면(hr/010 전) 지금까지처럼 된다. 있으면 그 사업장·달이 확정돼 있어야 한다.
export async function workClosedFor(workplaceId: string, month: string): Promise<boolean | null> {
  const c = await fetchClosings(month);
  return c.ready ? c.closed.some((x) => x.workplace_id === workplaceId) : null;
}
export const NEED_CLOSING = "근무대장을 확정한 뒤 급여를 저장할 수 있습니다. [근무대장]에서 그 달을 확정하세요.";
// 확정해도 되는가: 그 사업장 시급제 직원에게 '입력 전'인 날이 없어야 한다(월급제는 근무대장으로 급여를 계산하지 않는다). 남았으면 그 직원들.
export async function closingBlockers(workplaceId: string, month: string): Promise<{ name: string; days: number }[]> {
  const [workplaces, roster] = await Promise.all([fetchWorkplaces(), fetchRoster(month)]);
  const wp = workplaces.find((w) => w.id === workplaceId);
  if (!wp) return [];
  const staff = roster.filter((e) => e.workplace_id === workplaceId && e.pay_type === "hourly");
  const logs = await fetchLogs(month, staff.map((e) => e.id));
  const out: { name: string; days: number }[] = [];
  for (const e of staff) {
    const s = summarizeMonth(e, wp, logs.filter((l) => l.employee_id === e.id), month);
    if (s.missingDays > 0) out.push({ name: e.name, days: s.missingDays });
  }
  return out;
}

// ── 파일 → 계획 ─────────────────────────────────────────────────────
type EmpPlan = { e: RosterEmployee; add: number; change: number; rows: WorkLog[] };
export type PunchPlan = {
  report: PunchReport;
  emps: EmpPlan[];
  raw: { employee_id: string; work_date: string; in_time: string | null; out_time: string | null; schedule: string; source_name: string }[];
  autoNames: { source_name: string; employee_id: string }[];   // 같은 이름이 한 명이라 자동으로 짝지은 것(입력 완료 때 저장한다)
};

export async function planPunch(sheets: Sheet[], month: string, opts: { overwrite: boolean; decisions: Record<string, PunchDecision> }): Promise<PunchPlan> {
  let read: PunchRow[] | null = null;
  for (const s of sheets) { read = readPunchSheet(s.grid); if (read) break; }
  if (!read) throw new ImportError("'근무일자'·'이름'·'출근시간'·'퇴근시간' 칸이 있는 머리 줄을 찾지 못했습니다. 세콤에서 받은 출근 기록 파일을 올리세요.");

  const { from, to } = monthRange(month);
  const [roster, workplaces, nameMap, settings, hol, notesList, locked, closing] = await Promise.all([
    fetchRoster(month), fetchWorkplaces(), fetchNameMap(), fetchPunchSettings(), fetchHolidays(from, to), fetchNotes(from, to), confirmedWorkplaces(month), fetchClosings(month),
  ]);
  const wpOf = new Map<string, RosterWorkplace>(workplaces.map((w) => [w.id, w]));
  const empOf = new Map(roster.map((e) => [e.id, e]));
  const multiWp = workplaces.length > 1;
  const noteOf = new Map(notesList.map((n) => [`${n.employee_id}|${n.work_date}`, n]));
  const lockedWp = new Set([...locked, ...closing.closed.map((c) => c.workplace_id)]);
  const saved = new Map<string, WorkLog>();
  for (const l of await fetchLogs(month, roster.map((e) => e.id))) {
    if (l.work_date < from || l.work_date > to) continue;
    const { employee_id, ...log } = l;
    saved.set(`${employee_id}|${l.work_date}`, log);
  }

  // 이름 → 직원: 저장된 짝, 없으면 그 달 직원 가운데 같은 이름이 한 명일 때만 자동
  const inMonth = read.filter((r) => !r.error && r.date >= from && r.date <= to);
  const otherMonth = read.filter((r) => !r.error && (r.date < from || r.date > to)).length;
  const badLines = read.filter((r) => r.error);
  const names = new Map<string, PunchNameRow>();
  const autoNames: PunchPlan["autoNames"] = [];
  for (const r of inMonth) {
    let n = names.get(r.name);
    if (!n) {
      const hit = nameMap.get(r.name);
      if (hit) n = { source: r.name, employee_id: hit.employee_id, skip: hit.skip, state: "saved", days: 0, punched: 0 };
      else {
        const same = roster.filter((e) => e.name === r.name);
        n = same.length === 1 ? { source: r.name, employee_id: same[0].id, skip: false, state: "auto", days: 0, punched: 0 } : { source: r.name, employee_id: null, skip: false, state: "none", days: 0, punched: 0 };
        if (n.state === "auto") autoNames.push({ source_name: r.name, employee_id: same[0].id });
      }
      names.set(r.name, n);
    }
    n.days++;
    if (r.in || r.out) n.punched++;
  }
  const nameRows = [...names.values()].sort((a, b) => (a.state === "none" ? 0 : 1) - (b.state === "none" ? 0 : 1) || a.source.localeCompare(b.source, "ko"));
  const unmatched = nameRows.filter((n) => n.state === "none");
  // 두 이름이 한 직원에게 짝지어졌으면 넣지 않는다(어느 줄이 맞는지 알 수 없다)
  const owners = new Map<string, string[]>();
  for (const n of nameRows) if (n.employee_id && !n.skip) owners.set(n.employee_id, [...(owners.get(n.employee_id) || []), n.source]);
  const doubled = [...owners.entries()].filter(([, v]) => v.length > 1);

  const notes: string[] = [];
  const checks: PunchCheck[] = [];
  const counts = { people: 0, auto: 0, check: 0, keep: 0, open: 0, add: 0, change: 0 };
  const fresh = new Map<string, Map<string, WorkLog | null>>();   // 직원 → 날짜 → 넣을 줄(null = 그날 줄을 지운다는 뜻이 아니라 '넣지 않음')
  const raw: PunchPlan["raw"] = [];
  const seen = new Set<string>();
  let dup = 0, outside = 0, lockedRows = 0, gone = 0;
  const lockedNames = new Set<string>();

  for (const r of inMonth) {
    const n = names.get(r.name)!;
    if (n.skip || !n.employee_id) continue;
    const e = empOf.get(n.employee_id);
    if (!e) { if (r.in || r.out) gone++; continue; }                 // 짝지은 직원이 이 달 재직자가 아니다
    if (owners.get(e.id)!.length > 1) continue;
    const key = `${e.id}|${r.date}`;
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    if (r.date < e.hire_date || (e.leave_date && r.date > e.leave_date)) { if (r.in || r.out) outside++; continue; }
    if (lockedWp.has(e.workplace_id)) { lockedRows++; lockedNames.add(wpOf.get(e.workplace_id)?.name || ""); continue; }
    raw.push({ employee_id: e.id, work_date: r.date, in_time: r.in || null, out_time: r.out || null, schedule: r.schedule, source_name: r.name });

    const wp = wpOf.get(e.workplace_id);
    const off = dayOffsOf(hol.list, e.workplace_id, e.affiliation || "")[r.date];
    const fill = fillKindOf(off, r.date, wp?.five_plus ?? true);
    const plan = planDay({
      date: r.date, in: r.in, out: r.out, e, settings,
      scheduled: e.work_days.includes(weekdayOf(r.date)), off: fill, restDay: weekdayOf(r.date) === 7 || !!fill,
      existing: saved.get(key) || null, note: noteOf.get(key) || null, overwrite: opts.overwrite,
    });
    if (plan.status === "none") continue;
    if (plan.status === "keep") { counts.keep++; continue; }
    let decision = plan.proposal;
    if (plan.status === "check") {
      counts.check++;
      const picked = opts.decisions[key];
      if (picked && plan.actions.includes(picked.action)) decision = picked;
      checks.push({
        key, employee_id: e.id, name: e.name, workplace: multiWp ? wp?.name || "" : "", date: r.date, in: r.in, out: r.out,
        issues: plan.issues, proposal: plan.proposal, actions: plan.actions,
        note: plan.note ? { kind: plan.note.kind, in_time: plan.note.in_time, out_time: plan.note.out_time, memo: plan.note.memo } : null,
        sched: { start: e.work_start, end: e.work_end, break_min: e.break_min },
      });
    } else counts.auto++;
    const memo = plan.status === "check" && decision?.action !== "skip" ? `세콤: ${plan.issues.join(", ")}`.slice(0, 200) : "";
    const made = decisionLog(r.date, decision, e, memo);
    if (!made.ok) { counts.open++; continue; }
    if (!fresh.has(e.id)) fresh.set(e.id, new Map());
    fresh.get(e.id)!.set(r.date, made.log);
  }

  const emps: EmpPlan[] = [];
  for (const [id, days] of fresh) {
    const e = empOf.get(id)!;
    const all = new Map<string, WorkLog>();
    for (const [k, l] of saved) if (k.startsWith(`${id}|`)) all.set(l.work_date, l);
    let add = 0, change = 0;
    for (const [d, l] of days) {
      if (!l) continue;                                  // 넣지 않음 — 이미 있던 줄은 그대로 둔다
      const old = all.get(d);
      if (!old) add++; else if (!sameWorkLog(old, l)) change++;
      all.set(d, l);
    }
    counts.add += add; counts.change += change;
    emps.push({ e, add, change, rows: [...all.values()].sort((a, b) => a.work_date.localeCompare(b.work_date)) });
  }
  emps.sort((a, b) => a.e.name.localeCompare(b.e.name, "ko"));
  counts.people = new Set(raw.map((x) => x.employee_id)).size;
  checks.sort((a, b) => a.name.localeCompare(b.name, "ko") || a.date.localeCompare(b.date));

  if (badLines.length > 0) notes.push(`읽지 못한 줄 ${badLines.length}줄은 넣지 않습니다(${badLines.slice(0, 3).map((b) => `${b.line}줄 ${b.error}`).join(", ")}${badLines.length > 3 ? " …" : ""}).`);
  if (otherMonth > 0) notes.push(`${month} 밖의 날짜 ${otherMonth}줄은 넣지 않습니다.`);
  if (counts.keep > 0) notes.push(`이미 근무대장에 적힌 ${counts.keep}일은 그대로 둡니다.`);
  if (lockedRows > 0) notes.push(`근무대장이나 급여가 확정된 사업장(${[...lockedNames].filter(Boolean).join(", ") || "그 달"})의 ${lockedRows}줄은 넣지 않습니다.`);
  if (dup > 0) notes.push(`같은 직원의 같은 날짜가 두 번 있는 ${dup}줄은 첫 줄만 씁니다.`);
  if (outside > 0) notes.push(`입사 전이나 퇴사 뒤 날짜에 찍힌 ${outside}줄은 넣지 않습니다.`);
  if (gone > 0) notes.push(`짝지은 직원이 이 달 재직자가 아니어서 넣지 않는 찍힌 줄이 ${gone}줄 있습니다.`);
  const skipped = nameRows.filter((n) => n.skip).length;
  if (skipped > 0) notes.push(`'넣지 않음'으로 둔 이름 ${skipped}명은 건너뜁니다.`);

  // 이 달의 줄이 하나도 없으면(다른 달 파일을 올렸을 때) 파일에 가장 많은 달을 알려 준다
  const fileMonths = new Map<string, number>();
  for (const r of read) if (!r.error) fileMonths.set(r.date.slice(0, 7), (fileMonths.get(r.date.slice(0, 7)) || 0) + 1);
  const topMonth = [...fileMonths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const nothing = inMonth.length === 0
    ? (topMonth && topMonth !== month ? `이 파일은 ${Number(topMonth.slice(0, 4))}년 ${Number(topMonth.slice(5))}월 기록입니다. 달을 ${Number(topMonth.slice(5))}월로 바꾼 뒤 올리세요.` : "이 달에 넣을 줄이 없습니다. 달과 파일을 확인하세요.")
    : "";
  const blocked = nothing ? nothing : unmatched.length > 0 ? `짝을 정하지 않은 이름이 ${unmatched.length}명 있습니다. 직원을 고르거나 '넣지 않음'으로 두세요.`
    : doubled.length > 0 ? `한 직원에게 이름이 둘 이상 짝지어져 있습니다(${doubled.map(([id, v]) => `${empOf.get(id)?.name || ""}: ${v.join(", ")}`).join(" / ")}).`
    : counts.open > 0 ? `확인할 줄 ${counts.open}건을 정하세요.` : "";
  const report: PunchReport = {
    applied: false, month, settings, names: nameRows,
    employees: roster.map((e) => ({ id: e.id, name: e.name, workplace: multiWp ? wpOf.get(e.workplace_id)?.name || "" : "" })).sort((a, b) => a.name.localeCompare(b.name, "ko")),
    blocked, counts, checks, notes, failed: [],
  };
  return { report, emps, raw, autoNames };
}

// plan 대로 넣는다 — 이름 짝(자동으로 맞춘 것)과 세콤 원본을 먼저 남기고, 직원마다 한 달을 한 번에(hr.save_work_logs). 한 사람이 실패해도 나머지는 계속한다.
export async function applyPunch(plan: PunchPlan, actor: string, ip: string, file: string): Promise<{ saved: number; failed: string[] }> {
  const now = new Date().toISOString();
  if (plan.autoNames.length > 0) await saveNames(plan.autoNames.map((n) => ({ ...n, skip: false })), actor);
  for (let i = 0; i < plan.raw.length; i += 500) {
    const part = plan.raw.slice(i, i + 500).map((r) => ({ ...r, file_name: file.slice(0, 120), imported_by: actor, imported_at: now }));
    const { error } = await hrDb().from("punches").upsert(part, { onConflict: "employee_id,work_date" });
    if (error) throw error;
  }
  const { from, to } = monthRange(plan.report.month);
  let saved = 0, days = 0;
  const failed: string[] = [];
  for (const p of plan.emps) {
    if (p.add + p.change === 0) continue;
    const { error } = await hrDb().rpc("save_work_logs", { p_employee: p.e.id, p_from: from, p_to: to, p_rows: p.rows, p_actor: actor });
    if (error) { failed.push(`${p.e.name}: ${error.message || "저장하지 못했습니다"}`); continue; }
    saved++; days += p.add + p.change;
    await hrAudit({ actor, action: "work_save", ip, targetType: "employee", targetId: p.e.id, targetName: p.e.name, detail: { month: plan.report.month, rows: p.rows.length, via: "secom", added: p.add, changed: p.change } });
  }
  await hrAudit({ actor, action: "punch_import", ip, targetType: "work", targetName: plan.report.month, detail: { file, month: plan.report.month, employees: saved, days, checks: plan.report.counts.check, raw: plan.raw.length, failed: failed.length } });
  return { saved, failed };
}
