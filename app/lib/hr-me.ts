// 직원 확인 링크 — 서버 전용(node:crypto·DB). 화면·미들웨어에서 import 하지 말 것.
//
//  급여 창(/hr) 로그인과 별개의 길이다. 직원은 /me/<토큰> 을 열고 주민등록번호를 넣어 본인 것만 읽는다.
//   · 토큰: 무작위 32바이트(base64url 43자). DB 에는 sha-256(찾기용)과 암호문([링크 복사]용)만 둔다.
//   · 본인 확인: 입력한 13자리의 HMAC 을 인사대장의 rrn_hash 와 비교한다. 번호를 복호화하지도, 어디에 남기지도 않는다.
//       15분 안에 5번 틀리면 그 링크를 15분 잠근다. 맞히지 못하고 20번을 틀리면 링크가 잠겨, 담당자가 다시 만들어야 풀린다
//       (뒷자리는 경우의 수가 적어 시간만 들이면 맞힐 수 있다 — 횟수 자체를 막는다).
//   · 확인 상태: 서명한 쿠키(me_auth, 30일). 링크를 다시 만들면(version 이 바뀌면) 옛 쿠키는 통하지 않는다.
//   · 퇴사자는 퇴사일 뒤 90일까지. 끊은 링크·없는 링크·기한이 지난 링크는 모두 같은 '없는 링크'로 답한다.
//  이 길로는 그 직원 한 명의 자료만 읽을 수 있고, 고치는 기능은 없다.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hrDb, isHrPending } from "./hr-db";
import { derivedKey, openSecret, rrnHash, sealSecret } from "./hr-crypto";
import { todayKst } from "./hr";
import { addDays, isMonth, monthRange, summarizeMonth, type WorkKind, type WorkLog, type WorkPlace } from "./hr-work";
import { summarizeLeave, type LeaveEmployee } from "./hr-leave";
import { fetchGrants, fetchLeaveLogs } from "./hr-leave-db";
import type { PayResult } from "./hr-pay";
import type { MeBundle, MePayslip } from "./hr-me-types";

export const ME_COOKIE = "me_auth";
export const ME_TTL_S = 30 * 86400;
export const ME_MAX_FAILS = 5;
export const ME_LOCK_MIN = 15;
export const ME_BLOCK_FAILS = 20;
export const ME_BLOCKED = "여러 번 틀려 잠긴 링크입니다. 담당자에게 새 링크를 받으세요.";
export const ME_LEAVE_GRACE_DAYS = 90;
export const ME_GONE = "없는 링크이거나 사용이 끝난 링크입니다. 담당자에게 문의하세요.";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ── 토큰 ────────────────────────────────────────────────────────────
export const newToken = (): string => randomBytes(32).toString("base64url");
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export const sealToken = (token: string): string => sealSecret(token);
export const openToken = (enc: string): string => openSecret(enc);

// ── 확인 상태 쿠키 ──────────────────────────────────────────────────
// "me1|<링크 id>|<version>|<만료 epoch 초>.<hmac>"
const sign = (payload: string): string => createHmac("sha256", derivedKey("hr-me-session-v1")).update(payload).digest("base64url");
export function signMe(linkId: string, version: number): string {
  const payload = `me1|${linkId}|${version}|${Math.floor(Date.now() / 1000) + ME_TTL_S}`;
  return `${payload}.${sign(payload)}`;
}
export function verifyMe(cookie: string | undefined | null, linkId: string, version: number): boolean {
  if (!cookie) return false;
  const i = cookie.lastIndexOf(".");
  if (i <= 0) return false;
  const payload = cookie.slice(0, i), mac = cookie.slice(i + 1);
  let want: string;
  try { want = sign(payload); } catch { return false; }
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [tag, id, ver, exp] = payload.split("|");
  return tag === "me1" && id === linkId && Number(ver) === version && Number(exp) * 1000 > Date.now();
}

// ── 링크 찾기 ───────────────────────────────────────────────────────
export type MeLink = {
  id: string; version: number;
  employee: LeaveEmployee & { pay_type: "hourly" | "monthly"; rrn_hash: string | null };
};
// 토큰으로 링크와 직원을 찾는다. 모양이 틀린 토큰·없는 링크·끊은 링크·퇴사 뒤 90일이 지난 직원 = null.
export async function findLink(token: string): Promise<MeLink | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await hrDb().from("employee_links")
    .select("id,version,active,employees!inner(id,workplace_id,emp_no,name,dept,position,hire_date,leave_date,work_days,daily_hours,leave_basis,pay_type,rrn_hash)")
    .eq("token_hash", tokenHash(token)).maybeSingle();
  if (error) throw error;
  const r = data as unknown as (Row & { employees: Row | Row[] }) | null;
  if (!r || r.active === false) return null;
  const e = (Array.isArray(r.employees) ? r.employees[0] : r.employees) as Row | undefined;
  if (!e) return null;
  const leave = (e.leave_date as string) || null;
  if (leave && addDays(leave, ME_LEAVE_GRACE_DAYS) < todayKst()) return null;
  return {
    id: String(r.id), version: num(r.version) || 1,
    employee: {
      id: String(e.id), workplace_id: String(e.workplace_id), emp_no: String(e.emp_no ?? ""), name: String(e.name ?? ""),
      dept: String(e.dept ?? ""), position: String(e.position ?? ""), hire_date: String(e.hire_date ?? ""), leave_date: leave,
      work_days: Array.isArray(e.work_days) ? (e.work_days as unknown[]).map(Number) : [], daily_hours: num(e.daily_hours),
      leave_basis: e.leave_basis === "hire" || e.leave_basis === "fiscal" ? e.leave_basis : "",
      pay_type: e.pay_type === "monthly" ? "monthly" : "hourly", rrn_hash: (e.rrn_hash as string) || null,
    },
  };
}

// ── 본인 확인 ───────────────────────────────────────────────────────
// 마지막 성공 뒤로 이어진 실패. recent = 그 가운데 15분 안의 것(5 이상이면 15분 잠금), streak = 전부(20 이상이면 링크 잠김).
export type FailState = { recent: number; streak: number; locked: boolean; blocked: boolean };
export function countFails(rows: { ok: boolean; at: string }[], nowMs: number): FailState {
  const since = nowMs - ME_LOCK_MIN * 60_000;
  let recent = 0, streak = 0;
  for (const r of rows) { // 최근 것부터
    if (r.ok) break;
    streak++;
    if (new Date(r.at).getTime() >= since) recent++;
  }
  return { recent, streak, locked: recent >= ME_MAX_FAILS, blocked: streak >= ME_BLOCK_FAILS };
}
export async function failState(linkId: string): Promise<FailState> {
  const { data, error } = await hrDb().from("link_attempts").select("ok,at").eq("link_id", linkId).order("at", { ascending: false }).limit(ME_BLOCK_FAILS);
  if (error) throw error;
  return countFails((data || []) as { ok: boolean; at: string }[], Date.now());
}
// 링크를 다시 만들 때 — 새 주소는 깨끗한 횟수로 시작한다
export async function clearAttempts(linkId: string): Promise<void> {
  const { error } = await hrDb().from("link_attempts").delete().eq("link_id", linkId);
  if (error) throw error;
}
export async function recordAttempt(linkId: string, ip: string, ok: boolean): Promise<void> {
  const { error } = await hrDb().from("link_attempts").insert({ link_id: linkId, ip, ok });
  if (error) throw error; // 실패를 세지 못하면 잠금이 무의미하므로 본인 확인도 멈춘다
}
// 입력한 13자리가 그 직원의 번호인가. 번호가 등록돼 있지 않으면 늘 false.
export function rrnMatches(digits: string, hash: string | null): boolean {
  if (!hash || !/^\d{13}$/.test(digits)) return false;
  const a = Buffer.from(rrnHash(digits)), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── 직원이 보는 묶음 ────────────────────────────────────────────────
export async function loadMe(link: MeLink, wantMonth: string): Promise<MeBundle> {
  const e = link.employee;
  const today = todayKst();
  const month = isMonth(wantMonth) && wantMonth <= today.slice(0, 7) && wantMonth >= e.hire_date.slice(0, 7) ? wantMonth : today.slice(0, 7);

  const wpRes = await hrDb().from("workplaces").select("id,name,five_plus,week_start,weekly_pay_month,auto_weekly").eq("id", e.workplace_id).maybeSingle();
  if (wpRes.error) throw wpRes.error;
  const w = (wpRes.data || {}) as Row;
  const wp: WorkPlace = { five_plus: !!w.five_plus, week_start: num(w.week_start) || 1, weekly_pay_month: w.weekly_pay_month === "start" ? "start" : "end", auto_weekly: !!w.auto_weekly };

  // 급여명세서: 확정한 달만. 급여 표가 없으면 빈 목록
  let payslips: MePayslip[] = [];
  try {
    const p = await hrDb().from("payroll_lines").select("result,payrolls!inner(month,pay_date,status)")
      .eq("employee_id", e.id).eq("payrolls.status", "confirmed").limit(120);
    if (p.error) throw p.error;
    for (const r of (p.data || []) as unknown as Row[]) {
      const head = (Array.isArray(r.payrolls) ? r.payrolls[0] : r.payrolls) as { month?: string; pay_date?: string } | null;
      const result = r.result as PayResult | null;
      if (!head?.month || !result || !Array.isArray(result.items)) continue;
      // 명세서에 찍히는 것만 고른다 — 회사 부담 보험료·담당자용 확인 문구는 보내지 않는다
      payslips.push({
        month: head.month, pay_date: String(head.pay_date || ""),
        result: {
          basis: result.basis, items: result.items, pay_total: num(result.pay_total), taxable_total: num(result.taxable_total),
          exempt_total: num(result.exempt_total), deduct_total: num(result.deduct_total), net_pay: num(result.net_pay),
        },
      });
    }
    payslips = payslips.sort((a, b) => b.month.localeCompare(a.month)).slice(0, 36);
  } catch (err) {
    if (!isHrPending(err)) throw err;
  }

  // 연차: 오늘 기준. 연차 표가 없으면 null
  let leave: MeBundle["leave"] = null;
  try {
    const [grants, logs] = await Promise.all([fetchGrants([e.id]), fetchLeaveLogs([e.id], addDays(today, -1100))]);
    const s = summarizeLeave(grants, logs.uses, today);
    leave = {
      granted: s.granted, used: s.used, left: s.left, expiring: s.expiring, over: s.over,
      grants: s.grants.filter((g) => g.state === "valid" || g.state === "future"),
      uses: logs.uses.sort((a, b) => b.work_date.localeCompare(a.work_date)).slice(0, 60).map((u) => ({ work_date: u.work_date, days: u.days })),
    };
  } catch (err) {
    if (!isHrPending(err)) throw err;
  }

  // 근태: 고른 달의 근무대장(주휴·연장은 주 단위라 앞뒤 6일을 더 읽어 계산한다)
  const { from, to } = monthRange(month);
  const l = await hrDb().from("work_logs").select("work_date,kind,start_time,end_time,break_min,hours,night_hours,leave_days")
    .eq("employee_id", e.id).gte("work_date", addDays(from, -6)).lte("work_date", addDays(to, 6)).order("work_date").limit(200);
  if (l.error) throw l.error;
  const logs: WorkLog[] = ((l.data || []) as unknown as Row[]).map((r) => ({
    work_date: String(r.work_date), kind: String(r.kind) as WorkKind, start_time: (r.start_time as string) || null, end_time: (r.end_time as string) || null,
    break_min: num(r.break_min), hours: num(r.hours), night_hours: num(r.night_hours), leave_days: num(r.leave_days), memo: "",
  }));
  const s = summarizeMonth(e, wp, logs, month);

  return {
    need: null, today,
    me: { name: e.name, emp_no: e.emp_no, dept: e.dept, position: e.position, hire_date: e.hire_date, workplace: String(w.name ?? ""), pay_type: e.pay_type },
    payslips, leave,
    attendance: {
      month,
      logs: logs.filter((x) => x.work_date >= from && x.work_date <= to).map((x) => ({ work_date: x.work_date, kind: x.kind, start_time: x.start_time, end_time: x.end_time, hours: x.hours, night_hours: x.night_hours, leave_days: x.leave_days })),
      workDays: s.workDays, worked: s.worked, overtime: s.overtime, night: s.night, holiday: s.holidayBase + s.holidayOver, weekly: s.weeklyHours, leaveDays: s.leaveDays, absentDays: s.absentDays,
    },
  };
}
