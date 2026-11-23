"use client";

// 인사대장 — 재직·퇴사 직원 목록. 주민등록번호는 가림 표기로만 보이고, 전체는 인쇄·엑셀에서 고를 때만(이력에 남는다).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import {
  PAY_TYPE_LABEL, currentWage, hasLeftOn, numText, rateOn, tenureText, todayKst, wageText,
  type Employee, type Rate, type Workplace,
} from "@/app/lib/hr";
import { HrApiError, errText, hrApi, hrDownload } from "./api";
import EmployeeForm from "./EmployeeForm";
import ExcelImport from "./ExcelImport";

type Tab = "active" | "left" | "all";
const TAB_LABEL: Record<Tab, string> = { active: "재직", left: "퇴사", all: "전체" };

export default function HrEmployeesPage() {
  const router = useRouter();
  const toast = useToast();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [keyReady, setKeyReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("active");
  const [wp, setWp] = useState("");
  const [aff, setAff] = useState("");                               // 소속으로 좁혀 보기
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);              // 엑셀 올리기 창
  const [importWp, setImportWp] = useState("");                     // 사업장 칸이 빈 줄에 쓸 사업장
  const [out, setOut] = useState<null | "print" | "excel">(null);   // 내보내기 창
  const [printRrn, setPrintRrn] = useState<Record<string, string> | null>(null); // 인쇄할 때만 잠깐 들고 있는 전체 번호

  const today = todayKst();

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [w, e, r] = await Promise.all([
        hrApi<{ workplaces: Workplace[] }>("/api/hr/workplaces"),
        hrApi<{ employees: Employee[]; keyReady: boolean }>("/api/hr/employees"),
        hrApi<{ rates: Rate[] }>("/api/hr/rates"),
      ]);
      setWorkplaces(w.workplaces); setEmployees(e.employees); setKeyReady(e.keyReady); setRates(r.rates);
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "인사대장을 불러오지 못했습니다."));
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const wpName = useMemo(() => new Map(workplaces.map((w) => [w.id, w.name])), [workplaces]);
  // 소속: 고를 수 있는 이름 = (고른 사업장 또는 모든 사업장의) 소속 목록 + 직원에게 실제로 들어 있는 이름. 하나도 없으면 소속 열·칸을 보이지 않는다
  const affNames = useMemo(() => {
    const names: string[] = [];
    for (const w of workplaces) if (!wp || w.id === wp) for (const a of w.affiliations) if (!names.includes(a)) names.push(a);
    for (const e of employees) if ((!wp || e.workplace_id === wp) && e.affiliation && !names.includes(e.affiliation)) names.push(e.affiliation);
    return names;
  }, [workplaces, employees, wp]);
  const hasAff = affNames.length > 0;
  const inWp = useMemo(() => employees.filter((e) => (!wp || e.workplace_id === wp) && (!aff || e.affiliation === aff)), [employees, wp, aff]);
  const counts = useMemo(() => {
    // 재직 = 퇴사하지 않은 직원. 입사일이 아직 오지 않은 직원(입사 예정)도 여기에 든다 — 등록하고 계약서를 쓰는 때가 보통 입사 전이다
    const active = inWp.filter((e) => !hasLeftOn(e, today)).length;
    return { active, left: inWp.length - active, all: inWp.length } as Record<Tab, number>;
  }, [inWp, today]);
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase();
    return inWp.filter((e) => {
      const active = !hasLeftOn(e, today);
      if (tab === "active" && !active) return false;
      if (tab === "left" && active) return false;
      if (!k) return true;
      return [e.name, e.affiliation, e.dept, e.position, e.job, e.phone].some((v) => v.toLowerCase().includes(k));
    });
  }, [inWp, tab, q, today]);

  const minWage = rateOn(rates, today)?.min_wage ?? null;
  const multiWp = workplaces.length > 1;

  // 인쇄: 전체 번호를 골랐으면 받아 온 뒤 인쇄하고, 인쇄가 끝나면 메모리에서 지운다
  async function doPrint(full: boolean) {
    try {
      if (full) {
        const ids = rows.filter((e) => e.has_rrn).map((e) => e.id);
        const j = ids.length ? await hrApi<{ rrn: Record<string, string> }>("/api/hr/employees/rrn", "POST", { ids, purpose: "print" }) : { rrn: {} };
        setPrintRrn(j.rrn);
      } else setPrintRrn(null);
      setOut(null);
      setTimeout(() => window.print(), 150); // 창이 닫히고 인쇄용 표가 그려진 뒤
    } catch (err) { toast.error(errText(err, "인사대장을 인쇄하지 못했습니다.")); }
  }
  useEffect(() => {
    const clear = () => setPrintRrn(null);
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  async function doExcel(full: boolean) {
    try {
      await hrDownload("/api/hr/employees/export", { workplace_id: wp || undefined, affiliation: aff || undefined, status: tab, rrn: full ? "full" : "masked" }, `employees-${today}.xlsx`);
      setOut(null);
    } catch (err) { toast.error(errText(err, "인사대장을 내보내지 못했습니다.")); }
  }

  return (
    <div className="b2b-container">
      {/* 인사대장 인쇄는 A4 가로 — 이 화면에 있을 때만 적용된다 */}
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } }`}</style>

      <header className="b2b-page-head hr-noprint">
        <div><h1 className="b2b-page-title">인사대장</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={() => { setImportWp(wp || workplaces.find((w) => w.active)?.id || ""); setImportOpen(true); }} disabled={loading || workplaces.length === 0}>엑셀 올리기</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setOut("excel")} disabled={loading || rows.length === 0}>엑셀 내려받기</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setOut("print")} disabled={loading || rows.length === 0}>인사대장 인쇄</button>
          <button type="button" className="b2b-btn-primary" onClick={() => setFormOpen(true)} disabled={loading || workplaces.length === 0}>직원 등록</button>
        </div>
      </header>

      {error && <div className="b2b-error hr-noprint" role="alert">{error}</div>}
      {!loading && !error && !keyReady && (
        <div className="sm-warn hr-noprint">암호화 키(HR_DATA_KEY)가 서버에 없습니다. 주민등록번호를 저장하거나 볼 수 없습니다.</div>
      )}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : workplaces.length === 0 ? (
        <div className="b2b-empty">
          등록된 사업장이 없습니다.
          <div className="b2b-empty-action"><Link href="/hr/settings" className="b2b-btn-secondary">사업장 등록</Link></div>
        </div>
      ) : (
        <>
          <div className="hr-filters hr-noprint">
            <div className="sm-tabs">
              {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
                <button key={t} type="button" className={`sm-tab ${tab === t ? "is-active" : ""}`} onClick={() => setTab(t)}>
                  {TAB_LABEL[t]}<span className="sm-tab-count">{counts[t]}</span>
                </button>
              ))}
            </div>
            {multiWp && (
              <select className="b2b-input" value={wp} onChange={(e) => { setWp(e.target.value); setAff(""); }} aria-label="사업장">
                <option value="">모든 사업장</option>
                {workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            )}
            {hasAff && (
              <select className="b2b-input" value={aff} onChange={(e) => setAff(e.target.value)} aria-label="소속">
                <option value="">모든 소속</option>
                {affNames.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
            <input className="b2b-input hr-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색" aria-label="성명·부서 검색" />
          </div>

          {rows.length === 0 ? (
            <div className="b2b-empty hr-noprint">
              {q.trim() || wp || aff ? "조건에 맞는 직원이 없습니다." : tab === "left" ? "퇴사한 직원이 없습니다." : "등록된 직원이 없습니다."}
              <div className="b2b-empty-action">
                {q.trim() || wp || aff
                  ? <button type="button" className="b2b-btn-secondary" onClick={() => { setQ(""); setWp(""); setAff(""); }}>조건 지우기</button>
                  : <button type="button" className="b2b-btn-secondary" onClick={() => setFormOpen(true)}>직원 등록</button>}
              </div>
            </div>
          ) : (
            <div className="b2b-table-wrap hr-screen-only">
              <table className="b2b-table is-clickable hr-table">
                <thead>
                  <tr>
                    {multiWp && <th>사업장</th>}
                    {hasAff && <th>소속</th>}
                    <th>성명</th><th>주민등록번호</th><th>입사일</th>
                    {tab === "active" ? <th>근속</th> : <th>퇴사일</th>}
                    <th>부서</th><th>직위</th><th className="num">임금</th><th>연락처</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} onClick={() => router.push(`/hr/employees/${e.id}`)} tabIndex={0} role="link"
                      onKeyDown={(ev) => { if (ev.key === "Enter") router.push(`/hr/employees/${e.id}`); }}>
                      {multiWp && <td>{wpName.get(e.workplace_id) || ""}</td>}
                      {hasAff && <td>{e.affiliation}</td>}
                      <td><strong>{e.name}</strong></td>
                      <td className="hr-mono">{e.rrn_masked || <span className="sm-faint">미입력</span>}</td>
                      <td>{e.hire_date}</td>
                      {tab === "active" ? <td>{e.hire_date > today ? "입사 예정" : tenureText(e.hire_date, today)}</td> : <td>{e.leave_date || ""}</td>}
                      <td>{e.dept}</td>
                      <td>{e.position}</td>
                      <td className="num">{wageText(e)}</td>
                      <td>{e.phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 인쇄용 — 화면에는 보이지 않는다. 지금 조건에 맞는 직원이 그대로 찍힌다 */}
          <div className="hr-print-only">
            <div className="hr-print-head">
              <h1>인사대장</h1>
              <span>{wp ? wpName.get(wp) : workplaces.length === 1 ? workplaces[0].name : "모든 사업장"}{aff ? ` · ${aff}` : ""} · {TAB_LABEL[tab]} {rows.length}명 · {today} 기준</span>
            </div>
            <table className="hr-print-table">
              <thead>
                <tr>
                  {multiWp && !wp && <th>사업장</th>}
                  {hasAff && !aff && <th>소속</th>}
                  <th>성명</th><th>주민등록번호</th><th>주소</th><th>연락처</th><th>입사일</th><th>퇴사일</th>
                  <th>부서</th><th>직위</th><th>업무</th><th>고용 형태</th><th>임금</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    {multiWp && !wp && <td>{wpName.get(e.workplace_id) || ""}</td>}
                    {hasAff && !aff && <td>{e.affiliation}</td>}
                    <td>{e.name}</td><td>{printRrn?.[e.id] || e.rrn_masked}</td><td>{e.address}</td><td>{e.phone}</td>
                    <td>{e.hire_date}</td><td>{e.leave_date || ""}</td><td>{e.dept}</td><td>{e.position}</td><td>{e.job}</td><td>{e.emp_type}</td>
                    <td>{PAY_TYPE_LABEL[e.pay_type]} {numText(e.pay_type === "hourly" ? currentWage(e.wages)?.hourly_wage : currentWage(e.wages)?.monthly_wage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {formOpen && (
        <EmployeeForm employee={null} workplaces={workplaces} minWage={minWage} keyReady={keyReady}
          onClose={() => setFormOpen(false)}
          onSaved={(e, note) => {
            setFormOpen(false);
            setEmployees((p) => [...p, e]);
            if (note) toast.error(note); else toast.success(`${e.name} 직원을 등록했습니다`);
            router.push(`/hr/employees/${e.id}`);   // 등록한 직원의 인사기록카드로 — 거기서 [근로계약서 작성]으로 이어진다
          }} />
      )}
      {importOpen && (
        <ExcelImport title="인사대장 엑셀 올리기" endpoint="/api/hr/employees/import" extra={{ workplace_id: importWp }} unit="명" applyWord="등록"
          templateLabel="양식 내려받기" onTemplate={() => hrDownload("/api/hr/employees/import", { template: true }, "employees-template.xlsx")}
          onClose={() => setImportOpen(false)}
          onDone={(r) => {
            load();
            const n = r.counts.create + r.counts.update - r.failed.length;
            if (r.failed.length > 0) toast.error(`${r.failed.length}명을 넣지 못했습니다`); else toast.success(`직원 ${n}명을 넣었습니다`);
          }}>
          {multiWp && (
            <label className="b2b-field">
              <span className="b2b-field-label">사업장 칸이 빈 줄의 사업장</span>
              <select className="b2b-input" value={importWp} onChange={(e) => setImportWp(e.target.value)}>
                {workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
          )}
        </ExcelImport>
      )}
      {out && <OutDialog kind={out} count={rows.length} canFull={keyReady} onClose={() => setOut(null)} onGo={(full) => (out === "print" ? doPrint(full) : doExcel(full))} />}
    </div>
  );
}

// 인쇄·엑셀 전에 주민등록번호를 어떻게 넣을지 고른다. 기본은 가림.
function OutDialog({ kind, count, canFull, onClose, onGo }: { kind: "print" | "excel"; count: number; canFull: boolean; onClose: () => void; onGo: (full: boolean) => Promise<void> }) {
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);
  const title = kind === "print" ? "인사대장 인쇄" : "엑셀 내려받기";
  return (
    <div className="b2b-modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="b2b-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{title} {count}명</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="b2b-field">
            <span className="b2b-field-label">주민등록번호</span>
            <div className="sm-tabs" style={{ margin: 0 }}>
              <button type="button" className={`sm-tab ${!full ? "is-active" : ""}`} onClick={() => setFull(false)}>뒷자리 가림</button>
              <button type="button" className={`sm-tab ${full ? "is-active" : ""}`} onClick={() => setFull(true)} disabled={!canFull}>전체</button>
            </div>
          </div>
          {full && <div className="sm-warn">전체 번호를 내보낸 사실이 이력에 남습니다.</div>}
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" disabled={busy}
              onClick={async () => { setBusy(true); await onGo(full); setBusy(false); }}>
              {busy ? "준비 중..." : title}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
