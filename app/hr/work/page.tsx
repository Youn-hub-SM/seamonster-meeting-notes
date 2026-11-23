"use client";

// 근무대장(월 목록) — 그 달에 재직한 직원마다 한 줄: 일한 날·시간, 연장·야간·휴일, 주휴, 입력이 빠진 날.
//  줄을 누르면 그 직원의 한 달 입력 화면으로 간다.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { todayKst } from "@/app/lib/hr";
import {
  hoursText, isMonth, shiftMonth, summarizeMonth,
  type MonthSummary, type RosterEmployee, type RosterLog, type RosterWorkplace,
} from "@/app/lib/hr-work";
import { HrApiError, errText, hrApi, hrDownload } from "../api";
import ExcelImport from "../ExcelImport";
import PunchNotes from "./PunchNotes";

type Closing = { workplace_id: string; closed_by: string; closed_at: string };
// 저장된 시각(UTC) → 한국 날짜. 그대로 자르면 오전 9시 전에 확정한 날이 하루 앞으로 보인다
const kstDate = (iso: string): string => { const t = Date.parse(iso); return Number.isNaN(t) ? iso.slice(0, 10) : new Date(t + 9 * 3600e3).toISOString().slice(0, 10); };

export default function HrWorkPage() {
  return (
    <Suspense fallback={<div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>}>
      <WorkList />
    </Suspense>
  );
}

function WorkList() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const qMonth = params.get("month") || "";
  const month = isMonth(qMonth) ? qMonth : todayKst().slice(0, 7);
  const [employees, setEmployees] = useState<RosterEmployee[]>([]);
  const [workplaces, setWorkplaces] = useState<RosterWorkplace[]>([]);
  const [logs, setLogs] = useState<RosterLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [wp, setWp] = useState("");
  const [aff, setAff] = useState("");                    // 소속으로 좁혀 보기
  const [importOpen, setImportOpen] = useState(false);   // 엑셀 올리기 창
  const [notesOpen, setNotesOpen] = useState(false);     // 미리 적기 창
  // 근무대장 확정(hr/010): closed = 이 달을 확정한 사업장, ready = 확정 기능이 있는가, payLocked = 급여까지 확정된 사업장
  const [closing, setClosing] = useState<{ ready: boolean; closed: Closing[]; payLocked: string[] }>({ ready: false, closed: [], payLocked: [] });
  const [closeBusy, setCloseBusy] = useState("");
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await hrApi<{ employees: RosterEmployee[]; workplaces: RosterWorkplace[]; logs: RosterLog[]; locked?: string[]; closed?: Closing[]; closing_ready?: boolean }>(`/api/hr/work-logs?month=${month}`);
      setEmployees(j.employees); setWorkplaces(j.workplaces); setLogs(j.logs);
      setClosing({ ready: !!j.closing_ready, closed: j.closed || [], payLocked: j.locked || [] });
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "근무대장을 불러오지 못했습니다."));
    }
    setLoading(false);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const go = (m: string) => router.push(`/hr/work?month=${m}`);
  const wpOf = useMemo(() => new Map(workplaces.map((w) => [w.id, w])), [workplaces]);
  const rows = useMemo(() => {
    const byEmp = new Map<string, RosterLog[]>();
    for (const l of logs) { if (!byEmp.has(l.employee_id)) byEmp.set(l.employee_id, []); byEmp.get(l.employee_id)!.push(l); }
    const out: { e: RosterEmployee; s: MonthSummary; wpName: string }[] = [];
    for (const e of employees) {
      if (wp && e.workplace_id !== wp) continue;
      if (aff && (e.affiliation || "") !== aff) continue;
      const w = wpOf.get(e.workplace_id);
      if (!w) continue;
      out.push({ e, s: summarizeMonth(e, w, byEmp.get(e.id) || [], month), wpName: w.name });
    }
    return out;
  }, [employees, logs, wpOf, wp, aff, month]);
  const multiWp = workplaces.length > 1;
  const monthTitle = `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
  // 고를 수 있는 소속 = 이 달 직원에게 들어 있는 이름(고른 사업장 안에서). 없으면 소속 칸·열을 보이지 않는다
  const affNames = useMemo(() => [...new Set(employees.filter((e) => !wp || e.workplace_id === wp).map((e) => e.affiliation || "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")), [employees, wp]);

  // 확정 줄: 이 달에 직원이 있는 사업장마다(사업장으로 좁혔으면 그 사업장만)
  const closeRows = useMemo(() => workplaces.filter((w) => (!wp || w.id === wp) && employees.some((e) => e.workplace_id === w.id)).map((w) => {
    const staff = employees.filter((e) => e.workplace_id === w.id);
    const byEmp = (id: string) => logs.filter((l) => l.employee_id === id);
    const missing = staff.filter((e) => e.pay_type === "hourly").reduce((t, e) => t + summarizeMonth(e, w, byEmp(e.id), month).missingDays, 0);
    return { w, closed: closing.closed.find((c) => c.workplace_id === w.id) || null, payLocked: closing.payLocked.includes(w.id), missing };
  }), [workplaces, employees, logs, closing, wp, month]);

  async function setClosed(w: RosterWorkplace, close: boolean) {
    const ok = await confirm(close
      ? { title: `${monthTitle} 근무대장 확정`, body: `${multiWp ? `${w.name} · ` : ""}확정하면 이 달 근무대장을 고칠 수 없고, 급여를 저장할 수 있게 됩니다.`, action: "근무대장 확정" }
      : { title: `${monthTitle} 근무대장 확정 취소`, body: `${multiWp ? `${w.name} · ` : ""}근무대장을 다시 고칠 수 있게 됩니다. 저장해 둔 급여는 그대로 남고, 근무대장을 고치면 급여 화면에서 다시 저장해야 합니다.`, action: "확정 취소" });
    if (!ok) return;
    setCloseBusy(w.id);
    try {
      const j = await hrApi<{ ready: boolean; closed: Closing[] }>("/api/hr/attendance/closing", "POST", { workplace_id: w.id, month, close });
      setClosing((p) => ({ ...p, ready: j.ready, closed: j.closed }));
      toast.success(close ? "근무대장을 확정했습니다" : "확정을 취소했습니다");
    } catch (err) { toast.error(errText(err, "근무대장 확정을 바꾸지 못했습니다.")); }
    setCloseBusy("");
  }

  async function excel() {
    try { await hrDownload("/api/hr/work-logs/export", { month }, `work-${month}.xlsx`); }
    catch (err) { toast.error(errText(err, "근무대장을 내보내지 못했습니다.")); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">근무대장</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={() => setNotesOpen(true)} disabled={loading || employees.length === 0}>미리 적기</button>
          <button type="button" className="b2b-btn-primary" onClick={() => router.push(`/hr/work/punch?month=${month}`)} disabled={loading || employees.length === 0}>세콤 파일 넣기</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setImportOpen(true)} disabled={loading || employees.length === 0}>엑셀 올리기</button>
          <button type="button" className="b2b-btn-secondary" onClick={excel} disabled={loading || rows.length === 0}>엑셀 내려받기</button>
        </div>
      </header>

      <div className="hr-filters">
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(month, -1))}>이전 달</button>
        <input type="month" className="b2b-input hr-month" value={month} aria-label="달" onChange={(e) => { if (isMonth(e.target.value)) go(e.target.value); }} />
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(month, 1))}>다음 달</button>
        {multiWp && (
          <select className="b2b-input" value={wp} onChange={(e) => { setWp(e.target.value); setAff(""); }} aria-label="사업장">
            <option value="">모든 사업장</option>
            {workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {affNames.length > 0 && (
          <select className="b2b-input" value={aff} onChange={(e) => setAff(e.target.value)} aria-label="소속">
            <option value="">모든 소속</option>
            {affNames.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : rows.length === 0 ? (
        <div className="b2b-empty">{wp || aff ? "조건에 맞는 직원이 없습니다." : "이 달에 재직한 직원이 없습니다."}</div>
      ) : (
        <>
          {closing.ready && closeRows.length > 0 && (
            <ul className="hr-close-list">
              {closeRows.map(({ w, closed, payLocked, missing }) => (
                <li key={w.id}>
                  {multiWp && <strong>{w.name}</strong>}
                  {closed
                    ? <><span className="b2b-status-pill hr-pill-ok">근무대장 확정</span><span className="sm-muted">{closed.closed_by} · {kstDate(closed.closed_at)}</span></>
                    : <><span className="b2b-status-pill hr-pill-off">확정 전</span>{missing > 0 && <span className="sm-muted">시급제 입력 전 {missing}일</span>}</>}
                  {closed
                    ? (payLocked ? <span className="sm-muted">급여 확정됨</span> : <button type="button" className="b2b-btn-secondary" onClick={() => setClosed(w, false)} disabled={closeBusy === w.id}>확정 취소</button>)
                    : <button type="button" className="b2b-btn-primary" onClick={() => setClosed(w, true)} disabled={closeBusy === w.id || missing > 0}>근무대장 확정</button>}
                  {closed && !payLocked && <Link href={`/hr/pay?month=${month}&workplace=${w.id}`} prefetch={false} className="sm-link">급여로</Link>}
                </li>
              ))}
            </ul>
          )}
          <div className="b2b-table-wrap">
            <table className="b2b-table is-clickable hr-table">
              <thead>
                <tr>
                  {multiWp && <th>사업장</th>}
                  {affNames.length > 0 && !aff && <th>소속</th>}
                  <th>성명</th><th className="num">근무 일수</th><th className="num">근무 시간</th><th className="num">연장</th>
                  <th className="num">야간</th><th className="num">휴일 근무</th><th className="num">주휴</th><th className="num">연차(일)</th><th className="num">결근</th><th className="num">입력 전</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, s, wpName }) => {
                  const href = `/hr/work/${e.id}?month=${month}`;
                  return (
                    <tr key={e.id} onClick={() => router.push(href)} tabIndex={0} role="link" onKeyDown={(ev) => { if (ev.key === "Enter") router.push(href); }}>
                      {multiWp && <td>{wpName}</td>}
                      {affNames.length > 0 && !aff && <td>{e.affiliation || ""}</td>}
                      <td><strong>{e.name}</strong>{e.pay_type === "monthly" && <span className="b2b-status-pill hr-pill-off" style={{ marginLeft: 8 }}>월급</span>}</td>
                      <td className="num">{s.workDays}</td>
                      <td className="num">{hoursText(s.worked)}</td>
                      <td className="num">{hoursText(s.overtime)}</td>
                      <td className="num">{hoursText(s.night)}</td>
                      <td className="num">{hoursText(s.holidayBase + s.holidayOver)}</td>
                      <td className="num">{hoursText(s.weeklyHours)}</td>
                      <td className="num">{hoursText(s.leaveDays)}</td>
                      <td className="num">{s.absentDays > 0 ? <span className="hr-bad">{s.absentDays}</span> : 0}</td>
                      <td className="num">{s.missingDays > 0 ? <span className="b2b-status-pill hr-pill-off">{s.missingDays}일</span> : 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {notesOpen && (
        <PunchNotes month={month} today={todayKst()} onClose={() => setNotesOpen(false)}
          people={employees.map((e) => ({ id: e.id, name: e.name, workplace: multiWp ? wpOf.get(e.workplace_id)?.name || "" : "" })).sort((a, b) => a.name.localeCompare(b.name, "ko"))} />
      )}
      {importOpen && (
        <ExcelImport title={`근무대장 엑셀 올리기 — ${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`} endpoint="/api/hr/work-logs/import" extra={{ month }} unit="일" applyWord="넣기"
          templateLabel="이 달 양식 내려받기" onTemplate={() => hrDownload("/api/hr/work-logs/export", { month }, `work-${month}.xlsx`)}
          onClose={() => setImportOpen(false)}
          onDone={(r) => {
            load();
            if (r.failed.length > 0) toast.error(`${r.failed.length}명의 근무대장을 넣지 못했습니다`); else toast.success(`근무 ${r.counts.create + r.counts.update}일을 넣었습니다`);
          }} />
      )}
    </div>
  );
}
