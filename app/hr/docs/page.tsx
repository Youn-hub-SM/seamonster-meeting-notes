"use client";

// 증명서 — 재직증명서·경력증명서·원천징수증명서를 고른 직원 앞으로 발급해 인쇄한다(A4 세로 한 장).
//  내용은 인사대장·사업장·확정한 월 급여에서 읽는다. 용도·제출처·발급일은 여기서 넣고 저장하지 않는다.
//  [증명서 인쇄]를 누르면 발급한 사실이 이력에 남고 그 번호가 발급 번호로 찍힌다. 직인은 사업장 화면에서 올린 그림.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { isActiveOn, isDate, numText, tenureText, todayKst, type Employee, type Workplace } from "@/app/lib/hr";
import { isMonth } from "@/app/lib/hr-work";
import { DOC_KINDS, DOC_LABEL, DOC_TAB, dateKo, monthKo, sumWithholding, type DocKind, type WithholdingRow } from "@/app/lib/hr-docs";
import { HrApiError, errText, hrApi } from "../api";

type Extra = { stamp: string | null; withholding: WithholdingRow[] };
const spaced = (s: string) => (s.length <= 6 ? s.split("").join(" ") : s);

export default function HrDocsPage() {
  const toast = useToast();
  const today = todayKst();
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [employeeId, setEmployeeId] = useState("");
  const [kind, setKind] = useState<DocKind>("employment");
  const [purpose, setPurpose] = useState("");
  const [submitTo, setSubmitTo] = useState("");
  const [issueDate, setIssueDate] = useState(today);
  const [fullRrn, setFullRrn] = useState(false);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01`);
  const [to, setTo] = useState(today.slice(0, 7));
  const [extra, setExtra] = useState<Extra>({ stamp: null, withholding: [] });
  const [issued, setIssued] = useState<{ no: string; rrn: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [w, e] = await Promise.all([hrApi<{ workplaces: Workplace[] }>("/api/hr/workplaces"), hrApi<{ employees: Employee[] }>("/api/hr/employees")]);
        setWorkplaces(w.workplaces); setEmployees(e.employees);
      } catch (err) {
        if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "직원 목록을 불러오지 못했습니다."));
      }
      setLoading(false);
    })();
  }, []);

  const e = employees.find((x) => x.id === employeeId) || null;
  const wp = e ? workplaces.find((w) => w.id === e.workplace_id) || null : null;
  const active = e ? isActiveOn(e, issueDate) : false;

  // 직원·기간이 바뀌면 직인과 달별 원천징수 내역을 다시 받는다. 무엇이든 바뀌면 앞서 받은 발급 번호는 버린다(같은 번호로 다른 내용을 찍지 않게).
  const loadExtra = useCallback(async () => {
    if (!e || !isMonth(from) || !isMonth(to) || to < from) { setExtra({ stamp: null, withholding: [] }); return; }
    try {
      const j = await hrApi<Extra>(`/api/hr/docs?employee=${e.id}&workplace=${e.workplace_id}&from=${from}&to=${to}`);
      setExtra({ stamp: j.stamp, withholding: j.withholding });
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) toast.error(errText(err, "증명서 자료를 불러오지 못했습니다."));
    }
    // toast 는 렌더마다 새로 만들어질 수 있어 의존성에서 뺀다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e?.id, e?.workplace_id, from, to]);
  useEffect(() => { loadExtra(); }, [loadExtra]);
  useEffect(() => { setIssued(null); }, [employeeId, kind, purpose, submitTo, issueDate, fullRrn, from, to]);
  useEffect(() => {
    const clear = () => setIssued((p) => (p ? { ...p, rrn: null } : p)); // 인쇄가 끝나면 전체 번호는 메모리에서 지운다
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  const groups = useMemo(() => {
    const on = employees.filter((x) => isActiveOn(x, today)), off = employees.filter((x) => !isActiveOn(x, today));
    const label = (x: Employee) => `${x.name}${x.emp_no ? ` (${x.emp_no})` : ""}${workplaces.length > 1 ? ` · ${workplaces.find((w) => w.id === x.workplace_id)?.name || ""}` : ""}`;
    return { on, off, label };
  }, [employees, workplaces, today]);

  const problem = !e ? "직원을 고르세요"
    : !isDate(issueDate) ? "발급일을 입력하세요"
    : kind === "employment" && !active ? "발급일에 재직 중이 아닌 직원입니다. 경력증명서로 발급하세요"
    : kind === "withholding" && (!isMonth(from) || !isMonth(to) || to < from) ? "기간을 확인하세요"
    : kind === "withholding" && extra.withholding.length === 0 ? "그 기간에 확정한 급여가 없습니다"
    : "";

  async function issue() {
    if (!e || problem) { toast.error(problem || "직원을 고르세요"); return; }
    setBusy(true);
    try {
      const j = await hrApi<{ no: string; rrn: string | null }>("/api/hr/docs", "POST", {
        employee_id: e.id, kind, purpose, submit_to: submitTo, issue_date: issueDate, full_rrn: fullRrn && e.has_rrn, from, to,
      });
      setIssued({ no: j.no, rrn: j.rrn });
      setTimeout(() => window.print(), 200); // 발급 번호가 그려진 뒤
    } catch (err) { toast.error(errText(err, "증명서를 발급하지 못했습니다.")); }
    setBusy(false);
  }

  const idText = e ? (fullRrn && issued?.rrn ? issued.rrn : e.rrn_masked || e.birth_date || "") : "";
  const idLabel = e && (e.rrn_masked || (fullRrn && issued?.rrn)) ? "주민등록번호" : "생년월일";
  const until = e ? (e.leave_date && e.leave_date < issueDate ? e.leave_date : issueDate) : issueDate;
  const sum = sumWithholding(extra.withholding);

  return (
    <div className="b2b-container">
      <style>{`@media print { @page { size: A4 portrait; margin: 18mm 16mm; } }`}</style>

      <header className="b2b-page-head hr-noprint">
        <div><h1 className="b2b-page-title">증명서</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-primary" onClick={issue} disabled={busy || loading || !e}>{busy ? "발급 중..." : "증명서 인쇄"}</button>
        </div>
      </header>

      {error && <div className="b2b-error hr-noprint" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading hr-noprint">불러오는 중...</div> : error ? null : employees.length === 0 ? (
        <div className="b2b-empty hr-noprint">등록된 직원이 없습니다.</div>
      ) : (
        <div className="hr-docs">
          <div className="hr-docs-form hr-noprint">
            <label className="b2b-field">
              <span className="b2b-field-label">직원<span className="req">*</span></span>
              <select className="b2b-input" value={employeeId} onChange={(ev) => setEmployeeId(ev.target.value)}>
                <option value="">직원 선택</option>
                <optgroup label="재직">{groups.on.map((x) => <option key={x.id} value={x.id}>{groups.label(x)}</option>)}</optgroup>
                {groups.off.length > 0 && <optgroup label="퇴사">{groups.off.map((x) => <option key={x.id} value={x.id}>{groups.label(x)}</option>)}</optgroup>}
              </select>
            </label>
            <div className="b2b-field">
              <span className="b2b-field-label">서류</span>
              <div className="sm-tabs">
                {DOC_KINDS.map((k) => <button key={k} type="button" className={`sm-tab ${kind === k ? "is-active" : ""}`} onClick={() => setKind(k)}>{DOC_TAB[k]}</button>)}
              </div>
            </div>
            {kind === "withholding" && (
              <div className="hr-docs-range">
                <label className="b2b-field">
                  <span className="b2b-field-label">시작 달</span>
                  <input type="month" className="b2b-input" value={from} onChange={(ev) => setFrom(ev.target.value)} />
                </label>
                <label className="b2b-field">
                  <span className="b2b-field-label">끝 달</span>
                  <input type="month" className="b2b-input" value={to} onChange={(ev) => setTo(ev.target.value)} />
                </label>
              </div>
            )}
            <label className="b2b-field">
              <span className="b2b-field-label">용도</span>
              <input className="b2b-input" value={purpose} maxLength={100} onChange={(ev) => setPurpose(ev.target.value)} />
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">제출처</span>
              <input className="b2b-input" value={submitTo} maxLength={100} onChange={(ev) => setSubmitTo(ev.target.value)} />
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">발급일<span className="req">*</span></span>
              <input type="date" className="b2b-input" value={issueDate} onChange={(ev) => setIssueDate(ev.target.value)} />
            </label>
            <div className="b2b-field">
              <span className="b2b-field-label">주민등록번호</span>
              <div className="sm-tabs">
                <button type="button" className={`sm-tab ${!fullRrn ? "is-active" : ""}`} onClick={() => setFullRrn(false)}>뒷자리 가림</button>
                <button type="button" className={`sm-tab ${fullRrn ? "is-active" : ""}`} onClick={() => setFullRrn(true)} disabled={!e?.has_rrn}>전체</button>
              </div>
            </div>
            {fullRrn && <div className="sm-warn">전체 번호로 발급한 사실이 이력에 남습니다. 미리보기에는 가린 번호가 보이고 인쇄할 때 전체로 찍힙니다.</div>}
            {e && problem && <div className="sm-warn">{problem}</div>}
            {e && wp && !extra.stamp && <div className="hr-rule">이 사업장은 직인이 없어 &quot;(인)&quot; 자리만 찍힙니다. 직인은 [사업장] › [사업장 수정]에서 올립니다.</div>}
          </div>

          {/* 미리보기 = 인쇄되는 종이 */}
          <div className="hr-doc-wrap">
            {!e || !wp ? <div className="b2b-empty hr-noprint">직원을 고르면 미리보기가 나옵니다.</div> : (
              <article className="hr-doc">
                <div className="hr-doc-no">{issued ? `제 ${issued.no} 호` : <span className="hr-noprint">발급 번호는 인쇄할 때 매겨집니다</span>}</div>
                <h1 className={kind === "withholding" ? "is-long" : ""}>{kind === "withholding" ? DOC_LABEL[kind] : spaced(DOC_LABEL[kind])}</h1>

                <table className="hr-doc-table">
                  <tbody>
                    <tr><th>성명</th><td>{e.name}</td><th>{idLabel}</th><td>{idText}</td></tr>
                    <tr><th>주소</th><td colSpan={3}>{e.address}</td></tr>
                    <tr><th>소속</th><td>{[wp.name, e.dept].filter(Boolean).join(" ")}</td><th>직위</th><td>{e.position}</td></tr>
                    {kind === "employment" && (
                      <tr><th>입사일</th><td>{dateKo(e.hire_date)}</td><th>재직 기간</th><td>{tenureText(e.hire_date, until)}</td></tr>
                    )}
                    {kind === "career" && (
                      <>
                        <tr><th>근무 기간</th><td colSpan={3}>{dateKo(e.hire_date)} ~ {e.leave_date && e.leave_date < issueDate ? dateKo(e.leave_date) : `${dateKo(issueDate)} 현재`} ({tenureText(e.hire_date, until)})</td></tr>
                        <tr><th>담당 업무</th><td>{e.job}</td><th>고용 형태</th><td>{e.emp_type}</td></tr>
                      </>
                    )}
                    {kind === "withholding" && (
                      <tr><th>입사일</th><td>{dateKo(e.hire_date)}</td><th>증명 기간</th><td>{isMonth(from) && isMonth(to) ? `${monthKo(from)} ~ ${monthKo(to)}` : ""}</td></tr>
                    )}
                    <tr><th>용도</th><td>{purpose}</td><th>제출처</th><td>{submitTo}</td></tr>
                  </tbody>
                </table>

                {kind === "withholding" && (
                  <table className="hr-doc-table hr-doc-money">
                    <thead><tr><th>귀속월</th><th>지급일</th><th>급여액</th><th>비과세</th><th>과세 급여</th><th>소득세</th><th>지방소득세</th></tr></thead>
                    <tbody>
                      {extra.withholding.map((r) => (
                        <tr key={r.month}>
                          <td>{monthKo(r.month)}</td><td>{r.pay_date}</td><td className="num">{numText(r.pay_total)}</td><td className="num">{numText(r.exempt_total)}</td>
                          <td className="num">{numText(r.taxable_total)}</td><td className="num">{numText(r.income_tax)}</td><td className="num">{numText(r.local_tax)}</td>
                        </tr>
                      ))}
                      {extra.withholding.length === 0 && <tr><td colSpan={7}>그 기간에 확정한 급여가 없습니다.</td></tr>}
                      {extra.withholding.length > 0 && (
                        <tr className="is-sum">
                          <td colSpan={2}>합계</td><td className="num">{numText(sum.pay_total)}</td><td className="num">{numText(sum.exempt_total)}</td>
                          <td className="num">{numText(sum.taxable_total)}</td><td className="num">{numText(sum.income_tax)}</td><td className="num">{numText(sum.local_tax)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}

                <p className="hr-doc-say">
                  {kind === "employment" ? "위 사람은 위와 같이 재직하고 있음을 증명합니다."
                    : kind === "career" ? `위 사람은 위와 같이 ${e.leave_date && e.leave_date < issueDate ? "근무하였음" : "근무하고 있음"}을 증명합니다.`
                    : "위 사람의 근로소득에 대하여 위와 같이 소득세와 지방소득세를 원천징수하였음을 증명합니다."}
                </p>
                <p className="hr-doc-date">{dateKo(issueDate)}</p>

                <div className="hr-doc-sign">
                  <div className="hr-doc-co">{wp.name}</div>
                  <div className="hr-doc-meta">
                    {wp.biz_no && <span>사업자등록번호 {wp.biz_no}</span>}
                    {wp.address && <span>{wp.address}</span>}
                    {wp.phone && <span>전화 {wp.phone}</span>}
                  </div>
                  <div className="hr-doc-ceo">
                    대표자 <strong>{wp.ceo}</strong>
                    <span className="hr-doc-seal">(인){extra.stamp && <img src={extra.stamp} alt="" />}</span>
                  </div>
                </div>
              </article>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
