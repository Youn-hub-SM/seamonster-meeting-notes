"use client";

// 근무대장(월 목록) — 그 달에 재직한 직원마다 한 줄: 일한 날·시간, 연장·야간·휴일, 주휴, 입력이 빠진 날.
//  줄을 누르면 그 직원의 한 달 입력 화면으로 간다.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/app/components/Feedback";
import { todayKst } from "@/app/lib/hr";
import {
  hoursText, isMonth, shiftMonth, summarizeMonth,
  type MonthSummary, type RosterEmployee, type RosterLog, type RosterWorkplace,
} from "@/app/lib/hr-work";
import { HrApiError, errText, hrApi, hrDownload } from "../api";
import ExcelImport from "../ExcelImport";

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
  const [importOpen, setImportOpen] = useState(false);   // 엑셀 올리기 창

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await hrApi<{ employees: RosterEmployee[]; workplaces: RosterWorkplace[]; logs: RosterLog[] }>(`/api/hr/work-logs?month=${month}`);
      setEmployees(j.employees); setWorkplaces(j.workplaces); setLogs(j.logs);
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
      const w = wpOf.get(e.workplace_id);
      if (!w) continue;
      out.push({ e, s: summarizeMonth(e, w, byEmp.get(e.id) || [], month), wpName: w.name });
    }
    return out;
  }, [employees, logs, wpOf, wp, month]);
  const multiWp = workplaces.length > 1;

  async function excel() {
    try { await hrDownload("/api/hr/work-logs/export", { month }, `work-${month}.xlsx`); }
    catch (err) { toast.error(errText(err, "근무대장을 내보내지 못했습니다.")); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">근무대장</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={() => setImportOpen(true)} disabled={loading || employees.length === 0}>엑셀 올리기</button>
          <button type="button" className="b2b-btn-secondary" onClick={excel} disabled={loading || rows.length === 0}>엑셀 내려받기</button>
        </div>
      </header>

      <div className="hr-filters">
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(month, -1))}>이전 달</button>
        <input type="month" className="b2b-input hr-month" value={month} aria-label="달" onChange={(e) => { if (isMonth(e.target.value)) go(e.target.value); }} />
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(month, 1))}>다음 달</button>
        {multiWp && (
          <select className="b2b-input" value={wp} onChange={(e) => setWp(e.target.value)} aria-label="사업장">
            <option value="">모든 사업장</option>
            {workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : rows.length === 0 ? (
        <div className="b2b-empty">{wp ? "조건에 맞는 직원이 없습니다." : "이 달에 재직한 직원이 없습니다."}</div>
      ) : (
        <>
          <div className="b2b-table-wrap">
            <table className="b2b-table is-clickable hr-table">
              <thead>
                <tr>
                  {multiWp && <th>사업장</th>}
                  <th>사번</th><th>성명</th><th className="num">근무 일수</th><th className="num">근무 시간</th><th className="num">연장</th>
                  <th className="num">야간</th><th className="num">휴일 근무</th><th className="num">주휴</th><th className="num">연차(일)</th><th className="num">결근</th><th className="num">입력 전</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, s, wpName }) => {
                  const href = `/hr/work/${e.id}?month=${month}`;
                  return (
                    <tr key={e.id} onClick={() => router.push(href)} tabIndex={0} role="link" onKeyDown={(ev) => { if (ev.key === "Enter") router.push(href); }}>
                      {multiWp && <td>{wpName}</td>}
                      <td className="hr-mono">{e.emp_no}</td>
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
