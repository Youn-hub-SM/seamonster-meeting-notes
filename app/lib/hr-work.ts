// 근무대장 — 화면과 서버가 같이 쓰는 타입·순수 계산. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  급여가 시급 기준이라 급여 계산의 원천이 근무대장이다(docs/payroll-leave-plan.md 4장).
//  여기서는 "시간"만 낸다 — 금액(시간 × 시급)은 급여 계산(3단계)이 이 결과에 임금을 곱해 만든다.
//
//  계산 기준(바꾸면 급여가 달라진다):
//   · 주: 사업장의 첫 요일(week_start)부터 7일.
//   · 연장: 하루 기준 시간을 넘은 시간 + (하루 기준까지만 센) 주 합계가 주 기준 시간을 넘은 시간.
//       통상 근로자 = 하루 8시간·주 40시간. 주 소정근로 40시간 미만(단시간) = 그날의 소정근로시간·주 소정근로시간.
//       휴일 근무 시간은 연장에 넣지 않는다(휴일 가산을 따로 받는다).
//   · 휴일 근무: 8시간까지와 8시간 넘은 시간을 나눠 센다(가산율이 다르다).
//   · 주휴: 주 소정근로 15시간 이상 + 그 주의 소정근로일(입사 전·퇴사 뒤·무급 휴무 제외)에 결근·미입력이 없고
//       하루 이상 실제로 일했고 + 그 주 끝까지 재직. 시간 = 주 40시간 이상이면 8, 미만이면 주 소정근로시간 ÷ 5.
//   · 달이 바뀌는 주의 주휴는 사업장 설정(weekly_pay_month)대로 주가 끝나는 달 또는 시작하는 달에 넣는다.
//   · 연장·야간·휴일 가산과 주휴 자동 계산을 실제로 지급할지는 사업장 설정(five_plus·auto_weekly)이 정한다 —
//       여기서는 시간을 늘 계산하고, 적용 여부는 결과의 applies 로 알려 준다.

export const WORK_KINDS = ["work", "holiday_work", "paid_holiday", "leave", "absent", "unpaid"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  work: "근무", holiday_work: "휴일 근무", paid_holiday: "유급 휴일", leave: "연차", absent: "결근", unpaid: "무급 휴무",
};
export const LEAVE_PARTS = [0, 0.25, 0.5, 1] as const;
export const LEAVE_PART_LABEL: Record<string, string> = { "0": "없음", "0.25": "반반차", "0.5": "반차", "1": "연차" };

export type WorkLog = {
  work_date: string;            // YYYY-MM-DD
  kind: WorkKind;
  start_time: string | null;    // HH:MM
  end_time: string | null;
  break_min: number;
  hours: number;                // 실제 일한 시간
  night_hours: number;          // 그 가운데 22:00~06:00
  leave_days: number;           // 그날 쓴 연차(0·0.25·0.5·1)
  memo: string;
};

// 계산에 필요한 직원·사업장 칸만(화면 타입 Employee·Workplace 가 그대로 들어온다)
export type WorkEmployee = { hire_date: string; leave_date: string | null; work_days: number[]; daily_hours: number };
export type WorkPlace = { five_plus: boolean; week_start: number; weekly_pay_month: "end" | "start"; auto_weekly: boolean };

// 근무대장 화면이 받는 직원·사업장(인사대장 전체가 아니라 근무 계산에 쓰는 칸만 — 주민등록번호·계좌는 오지 않는다)
export type RosterEmployee = WorkEmployee & {
  id: string; workplace_id: string; emp_no: string; name: string; dept: string; position: string;
  pay_type: "hourly" | "monthly"; work_start: string; work_end: string; break_min: number;
};
export type RosterWorkplace = WorkPlace & { id: string; name: string };
export type RosterLog = WorkLog & { employee_id: string };

// ── 날짜 ────────────────────────────────────────────────────────────
const DAY_MS = 86400000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number): string => fromMs(toMs(d) + n * DAY_MS);
// 1=월 … 7=일
export const weekdayOf = (d: string): number => { const w = new Date(toMs(d)).getUTCDay(); return w === 0 ? 7 : w; };
export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export function monthRange(month: string): { from: string; to: string; days: string[] } {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = fromMs(Date.UTC(y, m, 0));
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return { from, to, days };
}
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}
// 그 날짜가 속한 주의 첫날
export function weekStartOf(d: string, weekStart: number): string {
  return addDays(d, -((weekdayOf(d) - weekStart + 7) % 7));
}
// 그 달과 겹치는 주를 모두 덮는 범위(주휴·연장은 주 단위라 앞뒤 달의 며칠이 필요하다)
export function monthWeeksRange(month: string, weekStart: number): { from: string; to: string } {
  const { from, to } = monthRange(month);
  return { from: weekStartOf(from, weekStart), to: addDays(weekStartOf(to, weekStart), 6) };
}

// ── 시각 → 시간 ─────────────────────────────────────────────────────
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (s: unknown): s is string => typeof s === "string" && TIME_RE.test(s);
const minutesOf = (t: string): number => { const m = TIME_RE.exec(t)!; return Number(m[1]) * 60 + Number(m[2]); };
export const round2 = (n: number): number => Math.round(n * 100) / 100;

// 출근·퇴근·휴게 → 일한 시간과 야간(22:00~06:00) 시간. 퇴근이 출근보다 이르거나 같으면 다음 날 퇴근으로 본다.
//  야간은 근무 구간과 야간 구간이 겹친 시간 — 휴게가 어느 시간대였는지는 알 수 없어 빼지 않는다(일한 시간보다 클 수는 없다).
//  휴게가 야간에 있었다면 야간 칸을 직접 고친다.
export function hoursFromTimes(start: string, end: string, breakMin: number): { hours: number; night: number } | null {
  if (!isTime(start) || !isTime(end)) return null;
  const a = minutesOf(start);
  let b = minutesOf(end);
  if (b <= a) b += 1440;
  const worked = b - a - Math.max(0, breakMin || 0);
  if (worked <= 0) return null;
  // 야간 구간(분): 전날 22:00~당일 06:00 = [-120, 360], 당일 22:00~다음 날 06:00 = [1320, 1800], 그다음 = [2760, 3240]
  let night = 0;
  for (const [s, e] of [[-120, 360], [1320, 1800], [2760, 3240]]) night += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return { hours: round2(worked / 60), night: round2(Math.min(night, worked) / 60) };
}

// ── 주·월 집계 ──────────────────────────────────────────────────────
export type WeekSummary = {
  start: string; end: string;
  worked: number;          // 근무 + 휴일 근무 시간
  overtime: number;        // 연장 시간
  night: number;           // 야간 시간
  holiday: number;         // 휴일 근무 시간
  scheduledDays: number;   // 그 주의 소정근로일 수(입사 전·퇴사 뒤·무급 휴무 제외)
  absentDays: number;      // 결근
  missingDays: number;     // 소정근로일인데 기록이 없는 날
  weeklyHours: number;     // 주휴 시간(대상이 아니면 0)
  weeklyReason: string;    // 주휴가 없는 이유("" = 대상)
  payMonth: string;        // 이 주의 주휴를 넣는 달(YYYY-MM)
};
export type MonthSummary = {
  month: string;
  workDays: number;        // 실제로 일한 날 수
  worked: number;          // 일한 시간(근무 + 휴일 근무)
  overtime: number;        // 연장 시간(이 달의 날짜에 생긴 것)
  night: number;
  holidayBase: number;     // 휴일 근무 가운데 하루 8시간까지
  holidayOver: number;     // 휴일 근무 가운데 하루 8시간을 넘은 시간
  weeklyHours: number;     // 주휴 시간(이 달에 넣는 주들의 합)
  paidHolidayHours: number;// 유급 휴일 시간
  leaveDays: number;       // 쓴 연차(일)
  leaveHours: number;      // 쓴 연차(시간 = 일 × 하루 소정근로시간)
  absentDays: number;
  unpaidDays: number;
  missingDays: number;     // 이 달의 소정근로일 가운데 기록이 없는 날
  scheduledDays: number;   // 이 달의 소정근로일 수(재직 기간 안)
  applies: { premium: boolean; weekly: boolean }; // 가산(연장·야간·휴일)·주휴 자동 계산을 실제로 적용하는가(사업장 설정)
  weeks: WeekSummary[];    // 이 달과 겹치는 주(첫 주·마지막 주는 앞뒤 달의 날을 포함한다)
  overtimeByDay: Record<string, number>;
};

// 주 소정근로시간 = 하루 소정근로시간 × 소정근로 요일 수
export const weeklyScheduledHours = (e: WorkEmployee): number => round2((e.daily_hours || 0) * (e.work_days?.length || 0));
// 주휴 시간: 주 40시간 이상이면 8, 미만이면 주 소정근로시간 ÷ 5(= ÷ 40 × 8). 15시간 미만이면 0.
export function weeklyHolidayHours(e: WorkEmployee): number {
  const w = weeklyScheduledHours(e);
  if (w < 15) return 0;
  return w >= 40 ? 8 : round2(w / 5);
}
const employedOn = (e: WorkEmployee, d: string) => e.hire_date <= d && (!e.leave_date || e.leave_date >= d);

export function summarizeMonth(e: WorkEmployee, wp: WorkPlace, logs: WorkLog[], month: string): MonthSummary {
  const byDate = new Map(logs.map((l) => [l.work_date, l]));
  const { from, to } = monthRange(month);
  const range = monthWeeksRange(month, wp.week_start);
  const scheduled = new Set(e.work_days || []);
  const weeklySched = weeklyScheduledHours(e);
  const partTime = weeklySched > 0 && weeklySched < 40;      // 단시간: 소정근로시간을 넘으면 연장
  const weekThreshold = partTime ? weeklySched : 40;
  const dayThreshold = (d: string) => (partTime ? (scheduled.has(weekdayOf(d)) ? e.daily_hours : 0) : 8);
  const weeklyBase = weeklyHolidayHours(e);

  const overtimeByDay: Record<string, number> = {};
  const weeks: WeekSummary[] = [];

  for (let ws = range.from; ws <= range.to; ws = addDays(ws, 7)) {
    const we = addDays(ws, 6);
    const w: WeekSummary = {
      start: ws, end: we, worked: 0, overtime: 0, night: 0, holiday: 0,
      scheduledDays: 0, absentDays: 0, missingDays: 0, weeklyHours: 0, weeklyReason: "",
      payMonth: (wp.weekly_pay_month === "start" ? ws : we).slice(0, 7),
    };
    let cumRegular = 0;       // 하루 기준까지만 센 주 누계(연장 판정용, 휴일 근무 제외)
    let actualWorkDays = 0;
    for (let d = ws; d <= we; d = addDays(d, 1)) {
      const log = byDate.get(d);
      const inJob = employedOn(e, d);
      const isSched = inJob && scheduled.has(weekdayOf(d)) && log?.kind !== "unpaid";
      if (isSched) w.scheduledDays++;

      if (log && inJob) {
        if (log.kind === "work") {
          const h = log.hours || 0;
          const dailyOver = Math.max(0, h - dayThreshold(d));
          const regular = h - dailyOver;
          const weeklyOver = Math.max(0, cumRegular + regular - Math.max(cumRegular, weekThreshold));
          cumRegular += regular;
          const ot = round2(dailyOver + weeklyOver);
          if (ot > 0) overtimeByDay[d] = ot;
          w.worked += h; w.overtime += ot; w.night += log.night_hours || 0;
          if (h > 0) actualWorkDays++;
        } else if (log.kind === "holiday_work") {
          w.worked += log.hours || 0; w.holiday += log.hours || 0; w.night += log.night_hours || 0;
          if ((log.hours || 0) > 0) actualWorkDays++;
        }
        if (log.kind === "absent" && isSched) w.absentDays++;
      }
      if (isSched && !log) w.missingDays++;
    }
    w.worked = round2(w.worked); w.overtime = round2(w.overtime); w.night = round2(w.night); w.holiday = round2(w.holiday);

    // 주휴
    if (weeklyBase <= 0) w.weeklyReason = "주 소정근로 15시간 미만";
    else if (e.hire_date > we || (e.leave_date != null && e.leave_date < ws)) w.weeklyReason = "재직 기간 아님";
    else if (e.leave_date != null && e.leave_date < we) w.weeklyReason = "주 끝까지 재직하지 않음";
    else if (w.scheduledDays === 0) w.weeklyReason = "소정근로일 없음";
    else if (w.absentDays > 0) w.weeklyReason = `결근 ${w.absentDays}일`;
    else if (w.missingDays > 0) w.weeklyReason = `입력 전 ${w.missingDays}일`;
    else if (actualWorkDays === 0) w.weeklyReason = "일한 날 없음";
    else w.weeklyHours = weeklyBase;
    weeks.push(w);
  }

  const m: MonthSummary = {
    month, workDays: 0, worked: 0, overtime: 0, night: 0, holidayBase: 0, holidayOver: 0, weeklyHours: 0,
    paidHolidayHours: 0, leaveDays: 0, leaveHours: 0, absentDays: 0, unpaidDays: 0, missingDays: 0, scheduledDays: 0,
    applies: { premium: !!wp.five_plus, weekly: !!wp.auto_weekly }, weeks, overtimeByDay,
  };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!employedOn(e, d)) continue;
    const log = byDate.get(d);
    const isSched = scheduled.has(weekdayOf(d)) && log?.kind !== "unpaid";
    if (isSched) m.scheduledDays++;
    if (!log) { if (isSched) m.missingDays++; continue; }
    if (log.kind === "work" || log.kind === "holiday_work") {
      const h = log.hours || 0;
      if (h > 0) m.workDays++;
      m.worked += h; m.night += log.night_hours || 0;
      if (log.kind === "holiday_work") { m.holidayBase += Math.min(h, 8); m.holidayOver += Math.max(0, h - 8); }
      m.overtime += overtimeByDay[d] || 0;
    } else if (log.kind === "paid_holiday") m.paidHolidayHours += e.daily_hours || 0;
    else if (log.kind === "absent") m.absentDays++;
    else if (log.kind === "unpaid") m.unpaidDays++;
    m.leaveDays += log.leave_days || 0;
  }
  m.leaveHours = round2(m.leaveDays * (e.daily_hours || 0));
  for (const w of weeks) if (w.payMonth === month) m.weeklyHours += w.weeklyHours;
  for (const k of ["worked", "overtime", "night", "holidayBase", "holidayOver", "weeklyHours", "paidHolidayHours", "leaveDays"] as const) m[k] = round2(m[k]);
  return m;
}

// ── 입력 ────────────────────────────────────────────────────────────
// 직원의 평소 근무(요일·시각·휴게)로 만든 하루 기록
export function defaultLog(e: { work_start: string; work_end: string; break_min: number; daily_hours: number }, date: string): WorkLog {
  const t = hoursFromTimes(e.work_start, e.work_end, e.break_min);
  return {
    work_date: date, kind: "work", start_time: t ? e.work_start : null, end_time: t ? e.work_end : null, break_min: t ? e.break_min : 0,
    hours: t ? t.hours : e.daily_hours, night_hours: t ? t.night : 0, leave_days: 0, memo: "",
  };
}

// 한 줄을 저장할 수 있는 모양으로 고친다(종류에 맞지 않는 칸은 비운다). 오류면 문장.
//  서버가 저장 전에 부르고, 화면도 같은 규칙으로 미리 보여 준다.
export function normalizeLog(raw: Partial<WorkLog> & { work_date: string }): { ok: true; log: WorkLog } | { ok: false; error: string } {
  const kind = (WORK_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as WorkKind) : null;
  if (!kind) return { ok: false, error: "종류를 고르세요" };
  const memo = String(raw.memo ?? "").trim().slice(0, 200);
  const base: WorkLog = { work_date: raw.work_date, kind, start_time: null, end_time: null, break_min: 0, hours: 0, night_hours: 0, leave_days: 0, memo };

  if (kind === "paid_holiday" || kind === "absent" || kind === "unpaid") return { ok: true, log: base };
  if (kind === "leave") {
    const part = Number(raw.leave_days) || 1;
    if (![0.25, 0.5, 1].includes(part)) return { ok: false, error: "연차는 1·0.5·0.25일" };
    return { ok: true, log: { ...base, leave_days: part } };
  }
  // 근무·휴일 근무
  const s = raw.start_time || "", en = raw.end_time || "";
  const breakMin = Math.round(Number(raw.break_min) || 0);
  if (breakMin < 0 || breakMin > 600) return { ok: false, error: "휴게는 0~600분" };
  let hours = Number(raw.hours) || 0;
  let night = raw.night_hours == null || (raw.night_hours as unknown) === "" ? NaN : Number(raw.night_hours);
  if (s || en) {
    if (!isTime(s) || !isTime(en)) return { ok: false, error: "출근·퇴근 시각을 모두 넣거나 모두 비우세요" };
    const t = hoursFromTimes(s, en, breakMin);
    if (!t) return { ok: false, error: "휴게가 근무 시간보다 깁니다" };
    hours = t.hours;
    if (!Number.isFinite(night)) night = t.night;
  }
  if (!(hours > 0)) return { ok: false, error: "근무 시간을 입력하세요" };
  if (hours > 24) return { ok: false, error: "근무 시간은 24시간 이하" };
  if (!Number.isFinite(night)) night = 0;
  if (night < 0) return { ok: false, error: "야간 시간은 0 이상" };
  const part = kind === "work" ? Number(raw.leave_days) || 0 : 0;
  if (![0, 0.25, 0.5].includes(part)) return { ok: false, error: "근무한 날의 연차는 반차·반반차만" };
  return {
    ok: true,
    log: { ...base, start_time: s || null, end_time: en || null, break_min: s ? breakMin : 0, hours: round2(hours), night_hours: round2(Math.min(night, hours)), leave_days: part },
  };
}

export const hoursText = (n: number | null | undefined): string => (n ? String(round2(n)) : "0");
