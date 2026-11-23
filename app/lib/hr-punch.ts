// 세콤 출근 기록 → 근무대장 — 화면과 서버가 같이 쓰는 타입·순수 규칙. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  흐름(2026-11-23 대표): 미리 적기 → 파일 넣기 → 보정 → 입력 완료 → 근무대장 확정 → 급여.
//  세콤 파일(실물 확인): 한 시트, 사람 × 날짜마다 한 줄 — 근무일자 · 이름 · 근무조 · 출근시간 · 퇴근시간 · 정상근무시간 · 휴일근무시간 · 근무스케줄.
//   · 정상근무시간·휴일근무시간 칸은 읽지 않는다(찍힌 평일이 모두 01:00 으로 나온다) — 근무 시간은 출퇴근 시각으로 계산한다.
//   · 이름은 인사대장과 다를 수 있어 짝(punch_names)으로 직원을 찾는다.
//  찍힌 시각 → 근무 시간(대표가 고른 권장안. 바꾸면 급여가 달라진다):
//   · 소정 출근보다 일찍 찍은 시간은 근무로 보지 않는다(출근 = 소정 출근 시각).
//   · 소정 퇴근 뒤에 찍은 시간도 근무로 보지 않는다(퇴근 = 소정 퇴근 시각). 다만 overtime_min 분 넘게 남았으면 연장인지 '확인할 줄'로 띄운다.
//   · 지각·조퇴는 찍힌 대로 줄인다. grace_min 분 안이면 지각·조퇴로 보지 않는다(08:01 에 찍은 것까지 깎지 않으려는 것).
//   · 휴게는 평소만큼 머문 날이면 직원의 평소 휴게, 덜 머문 날이면 법정 최소(4시간 30분 이하 0 · 8시간 미만 30분 · 8시간 이상 60분). 줄마다 고칠 수 있다.
//   · 소정 시각이 없는 직원은 찍힌 대로 넣고 '확인할 줄'로 띄운다.
//  확인할 줄: 한쪽만 찍힘 · 평일인데 안 찍힘 · 쉬는 날에 찍힘 · 지각·조퇴 · 퇴근 뒤 오래 남음. 평일에 안 찍힌 날은 자동으로 결근 처리하지 않고 반드시 고르게 한다.
//  이미 근무대장에 적힌 날은 그대로 둔다(연차는 언제나, 그 밖은 '덮기'를 고르지 않는 한).

import { WEEKDAYS } from "./hr";
import { cellText, normHead, type Cell, type Grid } from "./hr-import";
import { isTime, normalizeLog, type WorkLog } from "./hr-work";

// ── 설정 ────────────────────────────────────────────────────────────
export type PunchSettings = { grace_min: number; overtime_min: number };
export const PUNCH_DEFAULTS: PunchSettings = { grace_min: 10, overtime_min: 30 };
export function cleanSettings(raw: Partial<PunchSettings> | null | undefined): PunchSettings {
  const n = (v: unknown, d: number, max: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 && x <= max ? x : d; };
  return { grace_min: n(raw?.grace_min, PUNCH_DEFAULTS.grace_min, 60), overtime_min: n(raw?.overtime_min, PUNCH_DEFAULTS.overtime_min, 240) };
}

// ── 파일 읽기 ───────────────────────────────────────────────────────
export type PunchRow = { line: number; date: string; name: string; in: string; out: string; schedule: string; error?: string };
const HEADS: Record<string, string[]> = {
  date: ["근무일자", "근무일", "일자", "날짜"], name: ["이름", "성명"],
  in: ["출근시간", "출근시각", "출근"], out: ["퇴근시간", "퇴근시각", "퇴근"], schedule: ["근무스케줄", "스케줄"],
};
const pad = (n: number) => String(n).padStart(2, "0");
// 칸 값 → YYYY-MM-DD("2026/10/01"·"2026-10-01"·"2026.10.1"·"20261001"·날짜·엑셀 날짜 번호). 아니면 ""
export function punchDate(v: Cell | undefined): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "number") return v > 20000 && v < 80000 ? new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10) : "";
  const t = cellText(v).trim();
  const m = /^(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/.exec(t) || /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return ok ? `${y}-${pad(mo)}-${pad(d)}` : "";
}
// 칸 값 → HH:MM("7:54"·"07:54:33"·하루의 분수·날짜). 빈칸이면 "", 읽지 못하면 null
export function punchTime(v: Cell | undefined): string | null {
  if (v == null || v === "") return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === "number") { if (v < 0 || v >= 1) return null; const min = Math.floor(v * 1440 + 1e-6); return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
  const t = cellText(v).trim();
  if (!t) return "";
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad(Number(m[1]))}:${m[2]}`;
}
// 시트 → 줄들. 세콤 머리 줄(근무일자·이름·출근시간·퇴근시간)이 없으면 null
export function readPunchSheet(grid: Grid): PunchRow[] | null {
  const keyOf = new Map<string, string>();
  for (const [k, names] of Object.entries(HEADS)) for (const n of names) keyOf.set(normHead(n), k);
  let head = -1;
  const col: Record<string, number> = {};
  for (let i = 0; i < Math.min(grid.length, 8) && head < 0; i++) {
    const c: Record<string, number> = {};
    (grid[i] || []).forEach((v, j) => { const k = keyOf.get(normHead(v)); if (k && c[k] == null) c[k] = j; });
    if (c.date != null && c.name != null && c.in != null && c.out != null) { head = i; Object.assign(col, c); }
  }
  if (head < 0) return null;
  const out: PunchRow[] = [];
  for (let i = head + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const name = cellText(row[col.name]).trim();
    if (!name && cellText(row[col.date]).trim() === "") continue;   // 빈 줄
    const date = punchDate(row[col.date]);
    const tin = punchTime(row[col.in]), tout = punchTime(row[col.out]);
    const base: PunchRow = { line: i + 1, date, name, in: tin || "", out: tout || "", schedule: col.schedule != null ? cellText(row[col.schedule]).trim() : "" };
    if (!date) out.push({ ...base, error: "근무일자가 날짜가 아닙니다" });
    else if (!name) out.push({ ...base, error: "이름이 없습니다" });
    else if (tin === null || tout === null) out.push({ ...base, error: "출근·퇴근 시각을 읽지 못했습니다" });
    else out.push(base);
  }
  return out;
}

// ── 하루의 처리 ─────────────────────────────────────────────────────
export type PunchEmployee = { id: string; name: string; work_days: number[]; work_start: string; work_end: string; break_min: number; daily_hours: number };
export const NOTE_KINDS = ["in", "out", "both", "etc"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABEL: Record<NoteKind, string> = { in: "출근 못 찍음", out: "퇴근 못 찍음", both: "둘 다 못 찍음", etc: "기타" };
export type PunchNote = { id: string; employee_id: string; work_date: string; kind: NoteKind; in_time: string | null; out_time: string | null; memo: string; created_by?: string };

export const PUNCH_ACTIONS = ["work", "holiday_work", "leave", "absent", "unpaid", "paid_holiday", "skip"] as const;
export type PunchAction = (typeof PUNCH_ACTIONS)[number];
export const PUNCH_ACTION_LABEL: Record<PunchAction, string> = {
  work: "근무", holiday_work: "휴일 근무", leave: "연차", absent: "결근", unpaid: "무급 휴무", paid_holiday: "유급 휴일", skip: "넣지 않음",
};
export type PunchDecision = { action: PunchAction; start?: string; end?: string; break_min?: number };
export type DayStatus = "auto" | "check" | "keep" | "none";   // 자동으로 넣음 · 확인할 줄 · 이미 적힌 날(그대로) · 넣을 것 없음
export type DayPlan = {
  date: string; in: string; out: string;     // 찍힌 그대로
  status: DayStatus;
  issues: string[];                          // 확인할 까닭
  proposal: PunchDecision | null;            // 기본 처리. null = 반드시 골라야 한다
  actions: PunchAction[];                    // 고를 수 있는 처리
  note: PunchNote | null;
};

const minOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const timeOf = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
// 휴게(분). 평소만큼 머문 날(소정 시간에서 1시간 안쪽)은 직원의 평소 휴게.
//  덜 머문 날은 평소 휴게를 다 빼면 지나치므로 법정 최소로: 4시간 30분 이하 0 · 8시간 미만 30분 · 8시간 이상 60분(평소 휴게보다 크게는 아니다).
//  소정 시각을 모르면 4시간 30분을 넘을 때 평소 휴게. 보정 화면에서 줄마다 직접 고칠 수 있다.
export function breakFor(e: { break_min: number; work_start?: string; work_end?: string }, start: string, end: string): number {
  if (!isTime(start) || !isTime(end)) return 0;
  let span = minOf(end) - minOf(start);
  if (span <= 0) span += 1440;
  if (span <= 270) return 0;
  const b = Math.max(0, Math.round(e.break_min || 0));
  const full = isTime(e.work_start) && isTime(e.work_end) && minOf(e.work_end) > minOf(e.work_start) ? minOf(e.work_end) - minOf(e.work_start) : null;
  const out = full == null || span >= full - 60 ? b : span >= 480 ? Math.min(b, 60) : Math.min(b, 30);
  return out < span ? out : 0;
}
// 찍힌 출근·퇴근 → 근무대장에 넣을 출근·퇴근과 알릴 것
export function fitTimes(e: PunchEmployee, tin: string, tout: string, s: PunchSettings): { start: string; end: string; late: number; early: number; over: number; noSchedule: boolean; reversed: boolean } {
  const a = minOf(tin), b = minOf(tout);
  const reversed = b <= a;
  const S = isTime(e.work_start) ? minOf(e.work_start) : null, E = isTime(e.work_end) ? minOf(e.work_end) : null;
  if (S == null || E == null || E <= S || reversed) return { start: tin, end: tout, late: 0, early: 0, over: 0, noSchedule: S == null || E == null || E <= S, reversed };
  const late = a > S + s.grace_min ? a - S : 0;
  const early = b < E - s.grace_min ? E - b : 0;
  const over = b - E > s.overtime_min ? b - E : 0;
  return { start: late ? tin : timeOf(S), end: early ? tout : timeOf(E), late, early, over, noSchedule: false, reversed: false };
}
const minText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`);
// 맞춘 결과에서 알릴 것(지각·조퇴·퇴근 뒤 남음 …)
type Fit = ReturnType<typeof fitTimes>;
// 맞춘 출근·퇴근이 하루 근무로 성립하는가 — 출근이 퇴근보다 앞이어야 한다.
//  성립하지 않는 경우: 퇴근이 출근보다 이르거나 같게 찍힘, 출근이 소정 퇴근 뒤에 찍힘(퇴근은 소정 퇴근으로 맞춰져 뒤집힌다),
//  퇴근이 소정 출근 앞에 찍힘. 이런 날을 그대로 넣으면 '다음 날 퇴근'으로 읽혀 22~23시간 근무가 된다 — 기본 처리를 주지 않고 반드시 고르게 한다.
//  16시간 넘게 머문 것으로 찍힌 날(쉬는 날은 찍힌 대로 넣으므로 생길 수 있다)도 같은 까닭으로 기본 처리를 주지 않는다.
const MAX_SPAN = 16 * 60;
const sane = (f: Fit): boolean => !f.reversed && minOf(f.end) > minOf(f.start) && minOf(f.end) - minOf(f.start) <= MAX_SPAN;
const workOf = (e: PunchEmployee, f: Fit, action: PunchAction = "work"): PunchDecision | null =>
  (sane(f) ? { action, start: f.start, end: f.end, break_min: breakFor(e, f.start, f.end) } : null);
// 맞춘 결과에서 알릴 것(지각·조퇴·퇴근 뒤 남음 …)
function fitIssues(f: Fit): string[] {
  if (f.reversed) return ["퇴근이 출근보다 이르거나 같게 찍힘"];
  if (minOf(f.end) <= minOf(f.start)) return ["찍힌 시각이 소정 근무 시간 밖"];
  if (!sane(f)) return ["머문 시간이 16시간을 넘음"];
  const out: string[] = [];
  if (f.noSchedule) out.push("소정 출퇴근 시각이 없어 찍힌 대로");
  if (f.late) out.push(`지각 ${minText(f.late)}`);
  if (f.early) out.push(`조퇴 ${minText(f.early)}`);
  if (f.over) out.push(`퇴근 뒤 ${minText(f.over)} 남음`);
  return out;
}

export function planDay(a: {
  date: string; in: string; out: string; e: PunchEmployee; settings: PunchSettings;
  scheduled: boolean;                          // 그 직원의 소정근로 요일인가
  off: "paid_holiday" | "unpaid" | null;       // 그날 걸린 쉬는 날을 근무대장에 채우는 종류(없으면 null)
  restDay: boolean;                            // 일요일이거나 쉬는 날(휴일 근무로 볼 날)
  existing: WorkLog | null; note: PunchNote | null; overwrite: boolean;
}): DayPlan {
  const { date, e, settings, note } = a;
  const base = { date, in: a.in, out: a.out, note };
  const has = !!a.in || !!a.out;
  // 이미 적힌 날: 연차는 언제나 그대로(연차는 연차 화면에서), 그 밖은 덮기를 고르지 않는 한 그대로
  if (a.existing && (a.existing.kind === "leave" || a.existing.leave_days > 0 || !a.overwrite)) return { ...base, status: "keep", issues: [], proposal: null, actions: [] };
  const workday = a.scheduled && !a.off;

  if (!has) {
    if (!a.scheduled) return { ...base, status: "none", issues: [], proposal: null, actions: [] };
    if (a.off) return { ...base, status: "auto", issues: [], proposal: { action: a.off }, actions: [a.off] };
    const actions: PunchAction[] = ["work", "leave", "absent", "unpaid", "skip"];
    if (note && note.in_time && note.out_time) {
      const f = fitTimes(e, note.in_time, note.out_time, settings);
      return { ...base, status: "check", issues: ["안 찍힘 · 미리 적은 시각으로", ...fitIssues(f)], proposal: workOf(e, f), actions };
    }
    return { ...base, status: "check", issues: ["안 찍힘"], proposal: null, actions };
  }

  if (!workday) {
    const actions: PunchAction[] = ["holiday_work", "work", "skip"];
    if (a.in && a.out) {
      const f = fitTimes({ ...e, work_start: "", work_end: "" }, a.in, a.out, settings);   // 쉬는 날은 찍힌 대로
      const issues = [a.off ? "쉬는 날에 찍힘" : "근무일이 아닌 날에 찍힘", ...(sane(f) ? [] : fitIssues(f))];
      return { ...base, status: "check", issues, proposal: workOf(e, f, a.restDay ? "holiday_work" : "work"), actions };
    }
    return { ...base, status: "check", issues: [a.in ? "쉬는 날에 출근만 찍힘" : "쉬는 날에 퇴근만 찍힘"], proposal: { action: "skip" }, actions };
  }

  const actions: PunchAction[] = ["work", "leave", "absent", "unpaid", "skip"];
  if (!a.in || !a.out) {
    // 한쪽만 찍힘: 빈 쪽은 미리 적은 시각, 없으면 소정 시각
    const fillIn = a.in || note?.in_time || (isTime(e.work_start) ? e.work_start : "");
    const fillOut = a.out || note?.out_time || (isTime(e.work_end) ? e.work_end : "");
    const issue = `${a.in ? "퇴근" : "출근"} 안 찍힘${(a.in ? note?.out_time : note?.in_time) ? " · 미리 적은 시각으로" : ""}`;
    if (!isTime(fillIn) || !isTime(fillOut)) return { ...base, status: "check", issues: [issue], proposal: { action: "work", start: fillIn, end: fillOut }, actions };
    const f = fitTimes(e, fillIn, fillOut, settings);
    return { ...base, status: "check", issues: [issue, ...(f.reversed ? ["찍힌 시각이 소정 근무 시간 밖"] : fitIssues(f))], proposal: workOf(e, f), actions };
  }

  const f = fitTimes(e, a.in, a.out, settings);
  const issues = fitIssues(f);
  return { ...base, status: issues.length ? "check" : "auto", issues, proposal: workOf(e, f), actions };
}

// 고른 처리 → 근무대장 한 줄. skip 이면 log = null(넣지 않는다). 모자라면 문장.
export function decisionLog(date: string, d: PunchDecision | null | undefined, e: PunchEmployee, memo = ""): { ok: true; log: WorkLog | null } | { ok: false; error: string } {
  if (!d || !(PUNCH_ACTIONS as readonly string[]).includes(d.action)) return { ok: false, error: "처리를 고르세요" };
  if (d.action === "skip") return { ok: true, log: null };
  if (d.action === "leave") { const n = normalizeLog({ work_date: date, kind: "leave", leave_days: 1, memo }); return n.ok ? { ok: true, log: n.log } : n; }
  if (d.action === "absent" || d.action === "unpaid" || d.action === "paid_holiday") { const n = normalizeLog({ work_date: date, kind: d.action, memo }); return n.ok ? { ok: true, log: n.log } : n; }
  const start = d.start || "", end = d.end || "";
  if (!isTime(start) || !isTime(end)) return { ok: false, error: "출근·퇴근 시각을 넣으세요" };
  if (start === end) return { ok: false, error: "출근과 퇴근이 같은 시각입니다" };
  const brk = d.break_min == null || !Number.isFinite(Number(d.break_min)) ? breakFor(e, start, end) : Math.round(Number(d.break_min));
  const n = normalizeLog({ work_date: date, kind: d.action, start_time: start, end_time: end, break_min: brk, memo });
  return n.ok ? { ok: true, log: n.log } : n;
}

// ── 화면이 받는 묶음 ────────────────────────────────────────────────
export type PunchNameRow = {
  source: string;                 // 세콤 파일의 이름
  employee_id: string | null; skip: boolean;
  state: "saved" | "auto" | "none";   // 저장된 짝 · 같은 이름이 한 명이라 자동 · 아직 없음
  days: number; punched: number;      // 이 달의 줄 수 · 그 가운데 찍힌 날
};
export type PunchCheck = {
  key: string;                    // `${employee_id}|${date}`
  employee_id: string; name: string; workplace: string;
  date: string; in: string; out: string;
  issues: string[]; proposal: PunchDecision | null; actions: PunchAction[];
  note: { kind: NoteKind; in_time: string | null; out_time: string | null; memo: string } | null;
  sched: { start: string; end: string; break_min: number };   // 그 직원의 평소 근무(시각을 채울 때 쓴다)
};
export type PunchReport = {
  applied: boolean; month: string;
  settings: PunchSettings;
  names: PunchNameRow[];
  employees: { id: string; name: string; workplace: string }[];   // 이름 짝을 고를 때 쓰는 그 달의 직원
  blocked: string;                 // 넣을 수 없는 까닭("" = 넣을 수 있다)
  counts: { people: number; auto: number; check: number; keep: number; open: number; add: number; change: number };   // open = 아직 정하지 않은 확인할 줄
  checks: PunchCheck[];
  notes: string[];
  failed: string[];
};
export const dayLabel = (d: string): string => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} (${WEEKDAYS[w === 0 ? 6 : w - 1]})`; };
// 화면에서 그 줄을 정했는가(서버도 같은 것을 본다)
export function decisionProblem(d: PunchDecision | null | undefined): string {
  if (!d) return "처리를 고르세요";
  if (d.action === "work" || d.action === "holiday_work") {
    if (!isTime(d.start || "") || !isTime(d.end || "")) return "출근·퇴근 시각을 넣으세요";
    if (d.start === d.end) return "출근과 퇴근이 같은 시각입니다";
    // 휴게를 직접 넣었으면 서버(normalizeLog)와 같은 것을 본다: 0~600분, 머문 시간보다 짧아야 한다
    if (d.break_min != null) {
      const b = Number(d.break_min);
      let span = minOf(d.end as string) - minOf(d.start as string);
      if (span <= 0) span += 1440;
      if (!Number.isFinite(b) || b < 0 || b > 600) return "휴게는 0~600분";
      if (b >= span) return "휴게가 근무 시간보다 깁니다";
    }
  }
  return "";
}
