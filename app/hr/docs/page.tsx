"use client";

// 증명서·계약서 — 재직증명서·경력증명서·원천징수증명서·근로계약서를 고른 직원 앞으로 만들어 인쇄한다(A4 세로 한 장).
//  내용은 인사대장·사업장·확정한 월 급여에서 읽는다. 용도·제출처·발급일(계약서는 기간·장소·상여금·특약 등)은 여기서 넣고 저장하지 않는다.
//  [인쇄]를 누르면 발급한 사실이 이력에 남고, 증명서에는 그 번호가 발급 번호로 찍힌다. 직인은 사업장 화면에서 올린 그림.
//  주소에 ?employee=<id>&doc=contract 를 달고 오면 그 직원의 근로계약서가 바로 열린다(인사기록카드의 [근로계약서 작성]).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { WEEKDAYS, hasLeftOn, isActiveOn, isDate, numText, tenureText, todayKst, type Employee, type Workplace } from "@/app/lib/hr";
import { isMonth } from "@/app/lib/hr-work";
import {
  DOC_KINDS, DOC_LABEL, DOC_TAB, contractClauses, contractDefaults, contractProblem, dateKo, monthKo, sumWithholding,
  type ContractInput, type DocKind, type WithholdingRow,
} from "@/app/lib/hr-docs";
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
  const [ct, setCt] = useState<ContractInput | null>(null);   // 근로계약서에 넣을 값(직원을 고르면 인사대장에서 채운다)

  useEffect(() => {
    (async () => {
      try {
        const [w, e] = await Promise.all([hrApi<{ workplaces: Workplace[] }>("/api/hr/workplaces"), hrApi<{ employees: Employee[] }>("/api/hr/employees")]);
        setWorkplaces(w.workplaces); setEmployees(e.employees);
        // 인사기록카드에서 넘어온 경우: 그 직원·그 서류로 연다
        const sp = new URLSearchParams(window.location.search);
        const want = sp.get("employee") || "";
        if (e.employees.some((x) => x.id === want)) setEmployeeId(want);
        if (sp.get("doc") === "contract") setKind("contract");
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
  // 직원이 바뀌면 계약서 값을 그 직원의 인사대장 값으로 다시 채운다(고쳐 둔 값은 버린다 — 다른 사람의 조건이 남지 않게)
  useEffect(() => {
    setCt(e && wp ? contractDefaults(e, wp, today) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e?.id, wp?.id]);
  const setC = <K extends keyof ContractInput>(k: K, v: ContractInput[K]) => setCt((p) => (p ? { ...p, [k]: v } : p));
  const isContract = kind === "contract";
  const clauses = useMemo(() => (e && wp && ct ? contractClauses(e, wp, ct) : []), [e, wp, ct]);
  useEffect(() => {
    const clear = () => setIssued((p) => (p ? { ...p, rrn: null } : p)); // 인쇄가 끝나면 전체 번호는 메모리에서 지운다
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  const groups = useMemo(() => {
    // 입사일이 아직 오지 않은 직원은 '재직' 묶음에 둔다(근로계약서는 보통 입사 전에 쓴다)
    const on = employees.filter((x) => !hasLeftOn(x, today)), off = employees.filter((x) => hasLeftOn(x, today));
    const label = (x: Employee) => `${x.name}${workplaces.length > 1 ? ` · ${workplaces.find((w) => w.id === x.workplace_id)?.name || ""}` : ""}`;
    return { on, off, label };
  }, [employees, workplaces, today]);

  const problem = !e ? "직원을 고르세요"
    : isContract ? (ct ? contractProblem(ct) : "직원을 고르세요")
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
        employee_id: e.id, kind, from, to,
        ...(isContract ? { purpose: "", submit_to: "", issue_date: ct?.date || issueDate, full_rrn: false } : { purpose, submit_to: submitTo, issue_date: issueDate, full_rrn: fullRrn && e.has_rrn }),
      });
      setIssued({ no: j.no, rrn: j.rrn });
      setTimeout(() => window.print(), 200); // 발급 번호가 그려진 뒤
    } catch (err) { toast.error(errText(err, isContract ? "근로계약서를 인쇄하지 못했습니다." : "증명서를 발급하지 못했습니다.")); }
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
        <div><h1 className="b2b-page-title">증명서·계약서</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-primary" onClick={issue} disabled={busy || loading || !e}>{busy ? "발급 중..." : isContract ? "근로계약서 인쇄" : "증명서 인쇄"}</button>
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
            {!isContract && (
              <>
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
              </>
            )}
            {isContract && ct && (
              <>
                <label className="b2b-field">
                  <span className="b2b-field-label">계약일<span className="req">*</span></span>
                  <input type="date" className="b2b-input" value={ct.date} onChange={(ev) => setC("date", ev.target.value)} />
                </label>
                <div className="hr-docs-range">
                  <label className="b2b-field">
                    <span className="b2b-field-label">근로 시작일<span className="req">*</span></span>
                    <input type="date" className="b2b-input" value={ct.start} onChange={(ev) => setC("start", ev.target.value)} />
                  </label>
                  <label className="b2b-field">
                    <span className="b2b-field-label">근로 종료일<span className="opt"> 비우면 기간 없음</span></span>
                    <input type="date" className="b2b-input" value={ct.end} onChange={(ev) => setC("end", ev.target.value)} />
                  </label>
                </div>
                <label className="b2b-field">
                  <span className="b2b-field-label">근무 장소</span>
                  <input className="b2b-input" value={ct.place} maxLength={100} onChange={(ev) => setC("place", ev.target.value)} />
                </label>
                <label className="b2b-field">
                  <span className="b2b-field-label">업무의 내용</span>
                  <input className="b2b-input" value={ct.job} maxLength={100} onChange={(ev) => setC("job", ev.target.value)} />
                </label>
                <div className="hr-docs-range">
                  <label className="b2b-field">
                    <span className="b2b-field-label">주휴일</span>
                    <select className="b2b-input" value={ct.weeklyRest} onChange={(ev) => setC("weeklyRest", Number(ev.target.value))}>
                      {WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}요일</option>)}
                    </select>
                  </label>
                  <label className="b2b-field">
                    <span className="b2b-field-label">임금 지급일(매월)</span>
                    <input className="b2b-input num" inputMode="numeric" value={ct.payday || ""} onChange={(ev) => setC("payday", Math.min(31, Number(ev.target.value.replace(/[^\d]/g, "")) || 0))} />
                  </label>
                </div>
                <label className="b2b-field">
                  <span className="b2b-field-label">상여금<span className="opt"> 비우면 없음</span></span>
                  <input className="b2b-input" value={ct.bonus} maxLength={100} placeholder="예: 설·추석 각 300,000원" onChange={(ev) => setC("bonus", ev.target.value)} />
                </label>
                <label className="b2b-field">
                  <span className="b2b-field-label">기타 급여(제수당)<span className="opt"> 비우면 없음</span></span>
                  <input className="b2b-input" value={ct.allowances} maxLength={150} placeholder="예: 식대 200,000원" onChange={(ev) => setC("allowances", ev.target.value)} />
                </label>
                <div className="b2b-field">
                  <span className="b2b-field-label">지급 방법</span>
                  <div className="sm-tabs">
                    <button type="button" className={`sm-tab ${ct.payMethod === "bank" ? "is-active" : ""}`} onClick={() => setC("payMethod", "bank")}>통장 입금</button>
                    <button type="button" className={`sm-tab ${ct.payMethod === "cash" ? "is-active" : ""}`} onClick={() => setC("payMethod", "cash")}>직접 지급</button>
                  </div>
                </div>
                <label className="b2b-field">
                  <span className="b2b-field-label">특약 사항<span className="opt"> 한 줄에 하나</span></span>
                  <textarea className="b2b-input" rows={3} value={ct.special} maxLength={600} onChange={(ev) => setC("special", ev.target.value)} />
                </label>
              </>
            )}
            {e && problem && <div className="sm-warn">{problem}</div>}
            {e && wp && !extra.stamp && <div className="hr-rule">이 사업장은 직인이 없어 &quot;(인)&quot; 자리만 찍힙니다. 직인은 [사업장] › [사업장 수정]에서 올립니다.</div>}
          </div>

          {/* 미리보기 = 인쇄되는 종이 */}
          <div className="hr-doc-wrap">
            {!e || !wp ? <div className="b2b-empty hr-noprint">직원을 고르면 미리보기가 나옵니다.</div> : isContract ? (
              <article className="hr-doc hr-contract">
                <h1>{spaced(DOC_LABEL.contract)}</h1>
                <p className="hr-contract-lead">{wp.name}(이하 &quot;사업주&quot;라 함)과(와) {e.name}(이하 &quot;근로자&quot;라 함)은 다음과 같이 근로계약을 체결한다.</p>
                <ol className="hr-contract-list">
                  {clauses.map((c) => (
                    <li key={c.title}>
                      <strong>{c.title}</strong>
                      {c.lines.length === 1 && !c.checks ? <span>{c.lines[0]}</span> : c.lines.length > 0 && <ul>{c.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
                      {c.checks && <span className="hr-contract-checks">{c.checks.map((k) => <span key={k.label}><i className={k.on ? "is-on" : ""} aria-hidden="true" />{k.label}{k.on ? "" : " (해당 없음)"}</span>)}</span>}
                    </li>
                  ))}
                </ol>
                <p className="hr-doc-date">{dateKo(ct?.date || "")}</p>
                <div className="hr-contract-sign">
                  <div>
                    <b>(사업주)</b>
                    <span>사업체명: {wp.name}{wp.phone ? ` (전화: ${wp.phone})` : ""}</span>
                    <span>주소: {wp.address}</span>
                    <span>대표자: {wp.ceo} <span className="hr-doc-seal">(서명 또는 인){extra.stamp && <img src={extra.stamp} alt="" />}</span></span>
                  </div>
                  <div>
                    <b>(근로자)</b>
                    <span>주소: {e.address}</span>
                    <span>연락처: {e.phone}</span>
                    <span>성명: {e.name} <span className="hr-doc-seal">(서명 또는 인)</span></span>
                  </div>
                </div>
              </article>
            ) : (
              <article className="hr-doc">
                <div className="hr-doc-no">{issued ? `제 ${issued.no} 호` : <span className="hr-noprint">발급 번호는 인쇄할 때 매겨집니다</span>}</div>
                <h1 className={kind === "withholding" ? "is-long" : ""}>{kind === "withholding" ? DOC_LABEL[kind] : spaced(DOC_LABEL[kind])}</h1>

                <table className="hr-doc-table">
                  <tbody>
                    <tr><th>성명</th><td>{e.name}</td><th>{idLabel}</th><td>{idText}</td></tr>
                    <tr><th>주소</th><td colSpan={3}>{e.address}</td></tr>
                    <tr><th>소속</th><td>{[wp.name, e.affiliation, e.dept].filter(Boolean).join(" ")}</td><th>직위</th><td>{e.position}</td></tr>
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
