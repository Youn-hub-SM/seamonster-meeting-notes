"use client";

// 근무대장(개인별 한 달) — 하루 한 줄. 출근·퇴근·휴게를 넣으면 일한 시간과 야간 시간이 나오고, 시간만 적어도 된다.
//  주 소계(연장·주휴)와 위쪽 합계는 지금 적어 둔 값으로 바로 다시 계산된다(저장 전에도). 저장은 한 달을 통째로.

import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { WEEKDAYS, todayKst } from "@/app/lib/hr";
import {
  LEAVE_PART_LABEL, WORK_KINDS, WORK_KIND_LABEL, defaultLog, hoursFromTimes, hoursText, isMonth, monthRange, normalizeLog,
  shiftMonth, summarizeMonth, weekdayOf,
  type RosterEmployee, type RosterLog, type RosterWorkplace, type WorkKind, type WorkLog,
} from "@/app/lib/hr-work";
import { HrApiError, errText, hrApi, hrDownload } from "../../api";

// 화면에서 고치는 한 줄(입력칸 값 그대로 — 글자)
type Draft = { kind: WorkKind | ""; start: string; end: string; brk: string; hours: string; night: string; leave: string; memo: string };
const EMPTY: Draft = { kind: "", start: "", end: "", brk: "", hours: "", night: "", leave: "0", memo: "" };
const numStr = (n: number) => (n ? String(n) : "");

function fromLog(l: WorkLog): Draft {
  return {
    kind: l.kind, start: l.start_time || "", end: l.end_time || "", brk: l.start_time ? String(l.break_min) : "",
    hours: numStr(l.hours), night: numStr(l.night_hours), leave: String(l.leave_days || 0), memo: l.memo,
  };
}
function toRaw(date: string, d: Draft): Partial<WorkLog> & { work_date: string } {
  return {
    work_date: date, kind: d.kind || undefined, start_time: d.start || null, end_time: d.end || null,
    break_min: Number(d.brk) || 0, hours: Number(d.hours) || 0,
    night_hours: d.night === "" ? (undefined as unknown as number) : Number(d.night), leave_days: Number(d.leave) || 0, memo: d.memo,
  };
}
const isWorking = (k: Draft["kind"]) => k === "work" || k === "holiday_work";
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export default function HrWorkSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>}>
      <WorkSheet id={id} />
    </Suspense>
  );
}

function WorkSheet({ id }: { id: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const qMonth = search.get("month") || "";
  const month = isMonth(qMonth) ? qMonth : todayKst().slice(0, 7);
  const { from, to, days } = useMemo(() => monthRange(month), [month]);

  const [employee, setEmployee] = useState<RosterEmployee | null>(null);
  const [workplace, setWorkplace] = useState<RosterWorkplace | null>(null);
  const [serverLogs, setServerLogs] = useState<RosterLog[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState("");             // 저장된 상태의 지문 — 지금 값과 다르면 '고친 것이 있다'
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((logs: RosterLog[]) => {
    const d: Record<string, Draft> = {};
    for (const l of logs) if (l.work_date >= from && l.work_date <= to) d[l.work_date] = fromLog(l);
    setServerLogs(logs); setDraft(d); setSaved(JSON.stringify(d)); setRowErrors({}); setFormError("");
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await hrApi<{ employees: RosterEmployee[]; workplaces: RosterWorkplace[]; logs: RosterLog[] }>(`/api/hr/work-logs?month=${month}&employee=${id}`);
      const e = j.employees[0] || null;
      setEmployee(e); setWorkplace(j.workplaces.find((w) => w.id === e?.workplace_id) || null);
      adopt(j.logs);
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "근무대장을 불러오지 못했습니다."));
    }
    setLoading(false);
  }, [id, month, adopt]);
  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => JSON.stringify(draft) !== saved, [draft, saved]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // 지금 적어 둔 값으로 만든 기록(이 달) + 저장돼 있는 앞뒤 달의 며칠 → 주 소계·합계
  const live = useMemo(() => {
    const logs: WorkLog[] = serverLogs.filter((l) => l.work_date < from || l.work_date > to);
    const bad: Record<string, string> = {};
    for (const d of days) {
      const row = draft[d];
      if (!row || !row.kind) continue;
      const n = normalizeLog(toRaw(d, row));
      if (n.ok) logs.push(n.log); else bad[d] = n.error;
    }
    return { logs, bad };
  }, [draft, serverLogs, days, from, to]);
  const summary = useMemo(() => (employee && workplace ? summarizeMonth(employee, workplace, live.logs, month) : null), [employee, workplace, live.logs, month]);

  function edit(date: string, patch: Partial<Draft>, retime = false) {
    setDraft((p) => {
      const cur = p[date] || EMPTY;
      let next: Draft = { ...cur, ...patch };
      // 종류 없이 시각·시간부터 적으면 근무로 본다
      if (!next.kind && (patch.start || patch.end || patch.hours)) next.kind = "work";
      if (retime && next.start && next.end) {
        const t = hoursFromTimes(next.start, next.end, Number(next.brk) || 0);
        if (t) next = { ...next, hours: String(t.hours), night: numStr(t.night) };
      }
      if (retime && !next.start && !next.end) next.brk = ""; // 시각을 지우면 휴게도 비운다(시간만 적는 줄)
      return { ...p, [date]: next };
    });
    setRowErrors((p) => { if (!p[date]) return p; const n = { ...p }; delete n[date]; return n; });
  }
  function setKind(date: string, kind: Draft["kind"]) {
    if (!employee) return;
    if (kind === "") { setDraft((p) => { const n = { ...p }; delete n[date]; return n; }); return; }
    const cur = draft[date] || EMPTY;
    if (isWorking(kind)) {
      // 시간이 비어 있으면 평소 근무로 채운다
      const base = cur.hours || cur.start ? cur : fromLog(defaultLog(employee, date));
      edit(date, { ...base, kind, leave: kind === "work" && ["0.25", "0.5"].includes(cur.leave) ? cur.leave : "0", memo: cur.memo });
    } else if (kind === "leave") edit(date, { ...EMPTY, kind, leave: "1", memo: cur.memo });
    else edit(date, { ...EMPTY, kind, memo: cur.memo });
  }
  const employed = (d: string) => !!employee && employee.hire_date <= d && (!employee.leave_date || employee.leave_date >= d);

  function fillDefault() {
    if (!employee) return;
    // 기록이 없는 소정근로일만 채운다(이미 적은 날은 건드리지 않는다)
    const targets = days.filter((d) => !draft[d]?.kind && employed(d) && employee.work_days.includes(weekdayOf(d)));
    if (targets.length === 0) { toast.success("채울 빈 날이 없습니다"); return; }
    setDraft((p) => {
      const next = { ...p };
      for (const d of targets) if (!next[d]?.kind) next[d] = fromLog(defaultLog(employee, d));
      return next;
    });
  }

  async function save() {
    if (!employee) return;
    if (Object.keys(live.bad).length > 0) { setRowErrors(live.bad); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError("");
    try {
      const rows = days.filter((d) => draft[d]?.kind).map((d) => toRaw(d, draft[d]));
      const j = await hrApi<{ logs: RosterLog[] }>("/api/hr/work-logs", "PUT", { employee_id: employee.id, month, rows });
      adopt(j.logs);
      toast.success(`${employee.name} ${Number(month.slice(5))}월 근무대장을 저장했습니다`);
    } catch (err) {
      if (err instanceof HrApiError) { setRowErrors(err.rows); setFormError(err.message); }
      else setFormError("근무대장을 저장하지 못했습니다.");
    }
    setBusy(false);
  }

  async function leaveTo(href: string) {
    if (dirty && !(await confirm({ title: "저장하지 않은 변경", body: "이 달에서 고친 내용이 사라집니다.", action: "저장하지 않고 이동" }))) return;
    router.push(href);
  }
  async function excel() {
    if (dirty) { toast.error("변경을 저장한 뒤 내려받으세요"); return; }
    try { await hrDownload("/api/hr/work-logs/export", { month, employee_id: id }, `work-${month}.xlsx`); }
    catch (err) { toast.error(errText(err, "근무대장을 내보내지 못했습니다.")); }
  }
  function print() {
    if (dirty) { toast.error("변경을 저장한 뒤 인쇄하세요"); return; }
    window.print();
  }

  if (loading) return <div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>;
  if (error || !employee || !workplace || !summary) {
    return (
      <div className="b2b-container">
        <Link href={`/hr/work?month=${month}`} className="sm-link hr-back">근무대장</Link>
        <div className="b2b-error" role="alert">{error || "없는 직원입니다."}</div>
      </div>
    );
  }

  const weekByEnd = new Map<string, (typeof summary.weeks)[number]>();
  for (const w of summary.weeks) {
    // 주 소계는 그 주의 마지막 '이 달 날짜' 아래에 둔다
    const last = w.end > to ? to : w.end;
    if (last >= from && w.start <= to) weekByEnd.set(last, w);
  }
  const title = `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
  const tiles: [string, string, string?][] = [
    ["근무 일수", `${summary.workDays}일`, `소정근로일 ${summary.scheduledDays}일`],
    ["근무 시간", hoursText(summary.worked)],
    ["연장", hoursText(summary.overtime)],
    ["야간", hoursText(summary.night)],
    ["휴일 근무", hoursText(summary.holidayBase + summary.holidayOver), summary.holidayOver > 0 ? `8시간 초과 ${hoursText(summary.holidayOver)}` : undefined],
    ["주휴", hoursText(summary.weeklyHours)],
    ["연차·유급 휴일", hoursText(summary.leaveHours + summary.paidHolidayHours), summary.leaveDays > 0 ? `연차 ${hoursText(summary.leaveDays)}일` : undefined],
    ["결근", `${summary.absentDays}일`],
    ["입력 전", `${summary.missingDays}일`],
  ];
  const weeklySched = employee.daily_hours * employee.work_days.length;
  const partTime = weeklySched > 0 && weeklySched < 40;
  const weekText = (w: (typeof summary.weeks)[number]) =>
    `${md(w.start)}~${md(w.end)} 주   근무 ${hoursText(w.worked)}   연장 ${hoursText(w.overtime)}   야간 ${hoursText(w.night)}   휴일 근무 ${hoursText(w.holiday)}`;
  const weeklyText = (w: (typeof summary.weeks)[number]) =>
    w.weeklyHours > 0 ? `주휴 ${hoursText(w.weeklyHours)}시간${w.payMonth !== month ? ` (${Number(w.payMonth.slice(5))}월 급여)` : ""}` : `주휴 없음 — ${w.weeklyReason}`;

  return (
    <div className="b2b-container">
      {/* 근무대장 인쇄는 A4 세로 — 이 화면에 있을 때만 적용된다 */}
      <style>{`@media print { @page { size: A4 portrait; margin: 12mm; } }`}</style>

      <button type="button" className="b2b-link-btn hr-back hr-noprint" onClick={() => leaveTo(`/hr/work?month=${month}`)}>근무대장</button>
      <header className="b2b-page-head hr-noprint">
        <div className="hr-card-title">
          <h1 className="b2b-page-title">{employee.name}</h1>
          <span className="sm-muted">{workplace.name}{employee.dept ? ` · ${employee.dept}` : ""}{employee.position ? ` ${employee.position}` : ""}</span>
        </div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={fillDefault} disabled={busy}>평소대로 채우기</button>
          <button type="button" className="b2b-btn-secondary" onClick={excel} disabled={busy}>엑셀 내려받기</button>
          <button type="button" className="b2b-btn-secondary" onClick={print} disabled={busy}>근무대장 인쇄</button>
          <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? "저장 중..." : "변경 저장"}</button>
        </div>
      </header>

      <div className="hr-filters hr-noprint">
        <button type="button" className="b2b-btn-secondary" onClick={() => leaveTo(`/hr/work/${id}?month=${shiftMonth(month, -1)}`)}>이전 달</button>
        <input type="month" className="b2b-input hr-month" value={month} aria-label="달" onChange={(e) => { if (isMonth(e.target.value)) leaveTo(`/hr/work/${id}?month=${e.target.value}`); }} />
        <button type="button" className="b2b-btn-secondary" onClick={() => leaveTo(`/hr/work/${id}?month=${shiftMonth(month, 1)}`)}>다음 달</button>
        {dirty && <span className="b2b-status-pill hr-pill-off">저장 전</span>}
      </div>

      {formError && <div className="b2b-error hr-noprint" role="alert">{formError}</div>}

      <div className="hr-tiles hr-noprint">
        {tiles.map(([label, value, hint]) => (
          <div key={label} className="b2b-stat-card">
            <div className="b2b-stat-card-label">{label}</div>
            <div className="b2b-stat-card-value">{value}</div>
            {hint && <div className="b2b-stat-card-hint">{hint}</div>}
          </div>
        ))}
      </div>
      <p className="hr-rule hr-noprint">
        시간 단위. 연장 = {partTime ? `그날 소정근로시간·주 ${hoursText(weeklySched)}시간` : "하루 8시간·주 40시간"}을 넘은 시간, 휴일 근무는 연장에 넣지 않습니다.
        {!summary.applies.premium && " 이 사업장은 5인 미만이라 연장·야간·휴일 가산을 급여에 넣지 않습니다."}
        {!summary.applies.weekly && " 이 사업장은 주휴수당을 자동으로 계산하지 않습니다."}
      </p>

      <div className="b2b-table-wrap hr-screen-only">
        <table className="b2b-table hr-work-table">
          <thead>
            <tr><th>날짜</th><th>종류</th><th>출근</th><th>퇴근</th><th>휴게(분)</th><th>근무 시간</th><th>야간</th><th className="num">연장</th><th>연차</th><th>비고</th></tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const row = draft[d] || EMPTY;
              const inJob = employed(d);
              const sched = employee.work_days.includes(weekdayOf(d));
              const working = isWorking(row.kind);
              const timed = !!(row.start || row.end);
              const err = rowErrors[d]; // 저장을 눌렀을 때만 보인다(적는 도중에는 띄우지 않는다). 그 줄을 고치면 사라진다
              const week = weekByEnd.get(d);
              return [
                <tr key={d} className={`${sched ? "" : "hr-work-off"} ${inJob ? "" : "hr-work-out"}`}>
                  <td className="sm-nowrap">{md(d)} <span className="sm-muted">{WEEKDAYS[weekdayOf(d) - 1]}</span></td>
                  {!inJob ? <td colSpan={9} className="sm-faint">{d < employee.hire_date ? "입사 전" : "퇴사 뒤"}</td> : (
                    <>
                      <td>
                        <select className="b2b-input hr-w-kind" value={row.kind} aria-label={`${md(d)} 종류`} onChange={(e) => setKind(d, e.target.value as Draft["kind"])}>
                          <option value="">기록 없음</option>
                          {WORK_KINDS.map((k) => <option key={k} value={k}>{WORK_KIND_LABEL[k]}</option>)}
                        </select>
                      </td>
                      <td><input type="time" className="b2b-input hr-w-time" value={row.start} disabled={!!row.kind && !working} aria-label={`${md(d)} 출근`} onChange={(e) => edit(d, { start: e.target.value }, true)} /></td>
                      <td><input type="time" className="b2b-input hr-w-time" value={row.end} disabled={!!row.kind && !working} aria-label={`${md(d)} 퇴근`} onChange={(e) => edit(d, { end: e.target.value }, true)} /></td>
                      <td><input className="b2b-input num hr-w-num" inputMode="numeric" value={row.brk} disabled={!working || !timed} aria-label={`${md(d)} 휴게`} onChange={(e) => edit(d, { brk: e.target.value.replace(/[^\d]/g, "") }, true)} /></td>
                      <td><input className="b2b-input num hr-w-num" inputMode="decimal" value={row.hours} disabled={!!row.kind && !working} readOnly={working && timed} aria-label={`${md(d)} 근무 시간`} onChange={(e) => edit(d, { hours: e.target.value.replace(/[^\d.]/g, "") })} /></td>
                      <td><input className="b2b-input num hr-w-num" inputMode="decimal" value={row.night} disabled={!working} aria-label={`${md(d)} 야간`} onChange={(e) => edit(d, { night: e.target.value.replace(/[^\d.]/g, "") })} /></td>
                      <td className="num">{summary.overtimeByDay[d] ? hoursText(summary.overtimeByDay[d]) : ""}</td>
                      <td>
                        {row.kind === "work" ? (
                          <select className="b2b-input hr-w-leave" value={row.leave} aria-label={`${md(d)} 연차`} onChange={(e) => edit(d, { leave: e.target.value })}>
                            {["0", "0.25", "0.5"].map((v) => <option key={v} value={v}>{LEAVE_PART_LABEL[v]}</option>)}
                          </select>
                        ) : row.kind === "leave" ? (
                          <select className="b2b-input hr-w-leave" value={row.leave} aria-label={`${md(d)} 연차`} onChange={(e) => edit(d, { leave: e.target.value })}>
                            {["1", "0.5", "0.25"].map((v) => <option key={v} value={v}>{LEAVE_PART_LABEL[v]}</option>)}
                          </select>
                        ) : null}
                      </td>
                      <td>
                        <input className="b2b-input hr-w-memo" value={row.memo} disabled={!row.kind} maxLength={200} aria-label={`${md(d)} 비고`} onChange={(e) => edit(d, { memo: e.target.value })} />
                        {err && <div className="b2b-field-error">{err}</div>}
                      </td>
                    </>
                  )}
                </tr>,
                week && (
                  <tr key={`${d}-week`} className="hr-week-row">
                    <td colSpan={7}>{weekText(week)}</td>
                    <td colSpan={3} className={week.weeklyHours > 0 ? "" : "is-none"}>{weeklyText(week)}</td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      {/* 인쇄용 — 저장된 내용 그대로(저장 전에는 인쇄하지 않는다) */}
      <div className="hr-print-only">
        <div className="hr-print-head">
          <h1>근무대장 {title}</h1>
          <span>{workplace.name} · {employee.name}{employee.emp_no ? ` (${employee.emp_no})` : ""}{employee.dept ? ` · ${employee.dept}` : ""}{employee.position ? ` ${employee.position}` : ""}</span>
        </div>
        <table className="hr-print-table">
          <thead><tr><th>날짜</th><th>요일</th><th>종류</th><th>출근</th><th>퇴근</th><th>휴게(분)</th><th>근무 시간</th><th>야간</th><th>연장</th><th>연차</th><th>비고</th></tr></thead>
          <tbody>
            {days.map((d) => {
              const l = live.logs.find((x) => x.work_date === d);
              const week = weekByEnd.get(d);
              return [
                <tr key={d}>
                  <td>{md(d)}</td><td>{WEEKDAYS[weekdayOf(d) - 1]}</td><td>{l ? WORK_KIND_LABEL[l.kind] : ""}</td>
                  <td>{l?.start_time || ""}</td><td>{l?.end_time || ""}</td><td>{l?.start_time ? l.break_min : ""}</td>
                  <td>{l?.hours ? hoursText(l.hours) : ""}</td><td>{l?.night_hours ? hoursText(l.night_hours) : ""}</td>
                  <td>{summary.overtimeByDay[d] ? hoursText(summary.overtimeByDay[d]) : ""}</td>
                  <td>{l?.leave_days ? LEAVE_PART_LABEL[String(l.leave_days)] : ""}</td><td>{l?.memo || ""}</td>
                </tr>,
                week && <tr key={`${d}-week`} className="hr-print-week"><td colSpan={11}>{weekText(week)}   {weeklyText(week)}</td></tr>,
              ];
            })}
          </tbody>
        </table>
        <table className="hr-print-table hr-print-sum">
          <thead><tr>{tiles.map(([label]) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody><tr>{tiles.map(([label, value, hint]) => <td key={label}>{value}{hint ? ` (${hint})` : ""}</td>)}</tr></tbody>
        </table>
      </div>
    </div>
  );
}
