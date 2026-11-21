// 연차 — 화면과 서버가 같이 쓰는 타입·순수 계산. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  발생 규칙(docs/payroll-leave-plan.md 6-1). 바꾸면 직원의 연차가 달라진다:
//   · 대상: 5인 이상 사업장, 주 소정근로 15시간 이상. 5인 미만은 자동 발생이 없다(직접 넣는 것만).
//   · 입사 1년 미만: 1개월 개근마다 1일(최대 11일). 입사 1년 되는 날의 전날까지 쓴다.
//   · 입사일 기준: 입사 n주년에 15일 + 가산(3년차부터 2년마다 1일, 최대 25일). 다음 주년 전날까지.
//   · 회계연도 기준: 입사 뒤 첫 회계연도 첫날에 15 × (입사일부터 그 전날까지 일수 ÷ 365)일(소수점은 사업장 설정),
//       그 뒤 회계연도 첫날마다 15일 + 가산(연수는 회계연도로 센다 — 둘째 첫날이 1년차). 그 회계연도 말까지.
//       회계연도 첫날에 입사했으면 입사일 기준과 같아진다.
//   · 개근 = 그 기간에 근무대장의 '결근'이 없음. 1년 출근율(소정근로일 − 결근) ÷ 소정근로일 이 80% 미만이면 15일 대신 개근한 달 수.
//       근무대장에 기록이 없는 날은 출근으로 본다(알 수 없으므로).
//   · 단시간(주 40시간 미만): 일수 × (주 소정근로시간 ÷ 40 × 8) ÷ 하루 소정근로시간. 주 5일·하루 4시간이면 그대로, 주 3일·하루 8시간이면 0.6배.
//  사용 = 근무대장의 연차 줄(종류 '연차', 또는 근무한 날의 반차·반반차). 먼저 끝나는 발생 건부터 차감한다.
//  자동 발생 건은 (직원, auto_key) 로 한 번만 생긴다 — 화면을 열 때 "오늘까지 생겼어야 할 건"을 계산해 없는 것만 넣는다.

import type { Workplace } from "./hr";
import { addDays, round2, weekdayOf } from "./hr-work";

export type LeaveEmployee = {
  id: string; workplace_id: string; emp_no: string; name: string; dept: string; position: string;
  hire_date: string; leave_date: string | null; work_days: number[]; daily_hours: number; leave_basis: "" | "hire" | "fiscal";
};
export type LeaveWorkplace = Pick<Workplace, "id" | "name" | "five_plus" | "fiscal_start" | "leave_basis" | "leave_round">;
export type LeaveGrant = {
  id: string; employee_id: string; grant_date: string; expire_date: string | null; days: number;
  kind: "monthly" | "annual" | "manual"; auto_key: string | null; reason: string; voided: boolean;
  created_by: string; created_at: string;
};
export type LeaveUse = { employee_id: string; work_date: string; days: number; kind: string };
export type ExpectedGrant = { auto_key: string; grant_date: string; expire_date: string; days: number; kind: "monthly" | "annual"; reason: string };
export const GRANT_KIND_LABEL: Record<LeaveGrant["kind"], string> = { monthly: "월 발생", annual: "연 발생", manual: "직접 추가" };

// ── 날짜 ────────────────────────────────────────────────────────────
// n개월 뒤 같은 날(그 달에 없는 날이면 말일: 1/31 + 1개월 = 2/28)
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
export const addYears = (d: string, n: number): string => addMonths(d, 12 * n);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const minDate = (...ds: (string | null | undefined)[]): string => ds.filter((d): d is string => !!d).sort()[0];

export const leaveBasisOf = (e: Pick<LeaveEmployee, "leave_basis">, wp: Pick<LeaveWorkplace, "leave_basis">): "hire" | "fiscal" => e.leave_basis || wp.leave_basis || "fiscal";
export const annualDays = (n: number): number => Math.min(25, 15 + Math.floor((Math.max(1, n) - 1) / 2)); // n년차(만 n년을 채운 날에 생기는 일수)

function roundLeave(x: number, how: Workplace["leave_round"]): number {
  if (how === "ceil_half") return Math.ceil(x * 2 - 1e-9) / 2;
  if (how === "ceil_one") return Math.ceil(x - 1e-9);
  if (how === "round_half") return Math.round(x * 2) / 2;
  return round2(x);
}
// 단시간 비례: 통상 근로자 일수 → 이 직원의 하루(소정근로시간) 단위 일수
export function partTimeFactor(e: Pick<LeaveEmployee, "work_days" | "daily_hours">): number {
  const weekly = (e.daily_hours || 0) * (e.work_days?.length || 0);
  if (weekly < 15) return 0;
  if (weekly >= 40 || !e.daily_hours) return 1;
  return Math.min(1, ((weekly / 40) * 8) / e.daily_hours);
}

// ── 생겼어야 할 연차 ────────────────────────────────────────────────
//  absences = 그 직원의 결근 날짜. today 까지(퇴사했으면 퇴사일까지) 생긴 건을 돌려준다.
//  기본은 아직 끝나지 않은 건만(지난 건은 도입 전 사용을 알 수 없어 만들지 않는다). all 이면 전부(퇴사 정산 비교용).
export function expectedGrants(
  e: LeaveEmployee, wp: LeaveWorkplace, absences: ReadonlySet<string>, today: string,
  opt: { all?: boolean; basis?: "hire" | "fiscal" } = {},
): ExpectedGrant[] {
  const out: ExpectedGrant[] = [];
  const factor = partTimeFactor(e);
  if (!wp.five_plus || factor <= 0 || !e.hire_date) return out;
  const scale = (d: number) => round2(d * factor);
  const until = minDate(today, e.leave_date);
  const keep = (expire: string) => !!opt.all || expire >= today;
  const hasAbsence = (from: string, to: string) => { for (const a of absences) if (a >= from && a <= to) return true; return false; };
  const basis = opt.basis || leaveBasisOf(e, wp);
  const firstAnniv = addYears(e.hire_date, 1);

  // 입사 1년 미만: 1개월 개근마다 1일
  for (let i = 1; i <= 11; i++) {
    const g = addMonths(e.hire_date, i);
    if (g > until) break;
    const expire = addDays(firstAnniv, -1);
    if (!keep(expire) || hasAbsence(addMonths(e.hire_date, i - 1), addDays(g, -1))) continue;
    out.push({ auto_key: `m:${i}`, grant_date: g, expire_date: expire, days: scale(1), kind: "monthly", reason: `입사 ${i}개월 개근` });
  }

  // n년차 일수 — 앞 1년(from~to)의 출근율이 80% 미만이면 개근한 달 수
  const yearDays = (n: number, from: string, to: string): { days: number; note: string } => {
    let sched = 0, absent = 0;
    for (let d = from < e.hire_date ? e.hire_date : from; d <= to; d = addDays(d, 1)) {
      if (!e.work_days.includes(weekdayOf(d))) continue;
      sched++;
      if (absences.has(d)) absent++;
    }
    if (sched > 0 && (sched - absent) / sched < 0.8) {
      let months = 0;
      for (let i = 0; i < 12; i++) {
        const a = addMonths(from, i), b = addDays(addMonths(from, i + 1), -1);
        if (b > to) break;
        if (a >= e.hire_date && !hasAbsence(a, b)) months++;
      }
      return { days: months, note: `출근율 80% 미만 — 개근한 달 ${months}개` };
    }
    return { days: annualDays(n), note: "" };
  };

  if (basis === "hire") {
    for (let n = 1; n <= 60; n++) {
      const g = addYears(e.hire_date, n);
      if (g > until) break;
      const expire = addDays(addYears(e.hire_date, n + 1), -1);
      if (!keep(expire)) continue;
      const y = yearDays(n, addYears(e.hire_date, n - 1), addDays(g, -1));
      out.push({ auto_key: `a:${g}`, grant_date: g, expire_date: expire, days: scale(y.days), kind: "annual", reason: `입사 ${n}주년${y.note ? ` (${y.note})` : ""}` });
    }
  } else {
    const mmdd = /^\d{2}-\d{2}$/.test(wp.fiscal_start || "") && wp.fiscal_start !== "02-29" ? wp.fiscal_start : "01-01";
    const onStart = e.hire_date.slice(5) === mmdd;      // 회계연도 첫날 입사 = 입사일 기준과 같다
    let g = `${e.hire_date.slice(0, 4)}-${mmdd}`;
    if (g <= e.hire_date) g = addYears(g, 1);
    for (let k = 1; k <= 60; k++, g = addYears(g, 1)) {
      if (g > until) break;
      const expire = addDays(addYears(g, 1), -1);
      if (!keep(expire)) continue;
      if (k === 1) {
        const worked = daysBetween(e.hire_date, g);
        const days = scale(roundLeave(Math.min(15, (15 * worked) / 365), wp.leave_round));
        out.push({ auto_key: `a:${g}`, grant_date: g, expire_date: expire, days, kind: "annual", reason: `회계연도 첫 연차 (재직 ${worked}일 ÷ 365 × 15)` });
      } else {
        const n = k - 1 + (onStart ? 1 : 0);
        const y = yearDays(n, addYears(g, -1), addDays(g, -1));
        out.push({ auto_key: `a:${g}`, grant_date: g, expire_date: expire, days: scale(y.days), kind: "annual", reason: `회계연도 ${n}년차${y.note ? ` (${y.note})` : ""}` });
      }
    }
  }
  return out;
}

// 퇴사 정산 비교: 재직 기간 전체에 생긴 연차를 두 기준으로 더한다. 회계연도 기준이 적으면 그 차이만큼 직원에게 불리하다.
export function compareBases(e: LeaveEmployee, wp: LeaveWorkplace, absences: ReadonlySet<string>, today: string): { hire: number; fiscal: number; short: number } {
  const total = (basis: "hire" | "fiscal") => round2(expectedGrants(e, wp, absences, today, { all: true, basis }).reduce((t, g) => t + g.days, 0));
  const hire = total("hire"), fiscal = total("fiscal");
  return { hire, fiscal, short: round2(Math.max(0, hire - fiscal)) };
}

// ── 발생·사용·잔여 ──────────────────────────────────────────────────
export type GrantView = LeaveGrant & { used: number; left: number; state: "valid" | "expired" | "future" | "voided" | "minus" };
export type LeaveSummary = {
  granted: number;     // 지금 유효한 발생 건의 합
  used: number;        // 그 건들에서 쓴 일수
  left: number;        // 잔여
  expiring: number;    // 곧(soonDays 안에) 끝나는 건의 남은 일수
  over: number;        // 쓸 수 있는 발생 건 없이 쓴 일수(최근 1년)
  grants: GrantView[]; // 발생일 내림차순
};
// 먼저 끝나는 발생 건부터 차감한다. 빼는 건(일수가 음수인 직접 추가)은 그 날짜에 쓴 것처럼 차감한다.
export function summarizeLeave(grants: LeaveGrant[], uses: Pick<LeaveUse, "work_date" | "days">[], today: string, soonDays = 60): LeaveSummary {
  const live = grants.filter((g) => !g.voided);
  const pos = live.filter((g) => g.days > 0).sort((a, b) => (a.expire_date || "9999").localeCompare(b.expire_date || "9999") || a.grant_date.localeCompare(b.grant_date));
  const left = new Map(pos.map((g) => [g.id, g.days]));
  const take = [
    ...uses.filter((u) => u.days > 0).map((u) => ({ date: u.work_date, days: u.days })),
    ...live.filter((g) => g.days < 0).map((g) => ({ date: g.grant_date, days: -g.days })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const yearAgo = addDays(today, -365);
  let over = 0;
  for (const t of take) {
    let need = t.days;
    for (const g of pos) {
      if (need <= 0) break;
      const l = left.get(g.id) || 0;
      if (l <= 0 || g.grant_date > t.date || (g.expire_date && g.expire_date < t.date)) continue;
      const x = Math.min(l, need);
      left.set(g.id, round2(l - x)); need = round2(need - x);
    }
    if (need > 0 && t.date >= yearAgo) over += need;
  }
  const soon = addDays(today, soonDays);
  const s: LeaveSummary = { granted: 0, used: 0, left: 0, expiring: 0, over: round2(over), grants: [] };
  for (const g of grants) {
    const l = g.days > 0 && !g.voided ? left.get(g.id) ?? g.days : 0;
    const state: GrantView["state"] = g.voided ? "voided" : g.days < 0 ? "minus" : g.grant_date > today ? "future" : g.expire_date && g.expire_date < today ? "expired" : "valid";
    s.grants.push({ ...g, used: g.days > 0 && !g.voided ? round2(g.days - l) : 0, left: l, state });
    if (state !== "valid") continue;
    s.granted += g.days; s.used += g.days - l; s.left += l;
    if (g.expire_date && g.expire_date <= soon) s.expiring += l;
  }
  s.granted = round2(s.granted); s.used = round2(s.used); s.left = round2(s.left); s.expiring = round2(s.expiring);
  s.grants.sort((a, b) => b.grant_date.localeCompare(a.grant_date) || (b.auto_key || "").localeCompare(a.auto_key || ""));
  return s;
}

export const dayText = (n: number | null | undefined): string => (n ? String(round2(n)) : "0");
