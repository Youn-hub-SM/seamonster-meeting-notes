"use client";

// 퇴직금 — 직원 한 명의 퇴직금을 계산해 본다(저장하는 것이 없다 — 산정서를 인쇄해 남긴다).
//  퇴직금 = 1일 평균임금 × 30 × 재직일수 ÷ 365. 평균임금은 퇴직 전 3개월의 저장된 급여에서 채우고, 구간마다 직접 고칠 수 있다.
//  상여금처럼 1년치를 3/12 로 넣어야 하는 항목은 골라서 3개월 임금에서 빼고 연간 상여금으로 옮긴다. 계산 기준은 hr-severance.ts 머리말.

import { useCallback, useEffect, useMemo, useState } from "react";
import { isDate, numText } from "@/app/lib/hr";
import { bonusCandidates, bonusTotal, calcSeverance, dayCount, segmentAuto, severanceWindow, type SevBundle, type SevPick } from "@/app/lib/hr-severance";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";   // 업무도우미와 같이 쓰는 검색 고르기(화면 부품일 뿐 — 자료에는 닿지 않는다)
import { HrApiError, errText, hrApi } from "../api";

const won = (n: number) => `${numText(n)}원`;
const money2 = (n: number) => `${n.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`;
const pickLabel = (e: SevPick) => `${e.name}${e.leave_date ? ` · 퇴사 ${e.leave_date}` : ""}`;
const digits = (v: string) => v.replace(/[^\d]/g, "");

export default function HrSeverancePage() {
  const [picks, setPicks] = useState<SevPick[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [b, setB] = useState<SevBundle | null>(null);
  const [lastDay, setLastDay] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bonusNames, setBonusNames] = useState<Set<string>>(new Set());   // 연간 상여금으로 옮길 항목 이름
  const [over, setOver] = useState<Record<string, string>>({});           // 구간(시작일) → 직접 넣은 임금
  const [bonusOver, setBonusOver] = useState<string | null>(null);        // 연간 상여금을 직접 넣었으면 그 값
  const [leavePay, setLeavePay] = useState("");

  useEffect(() => {
    (async () => {
      try { setPicks((await hrApi<{ employees: SevPick[] }>("/api/hr/severance")).employees); }
      catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "직원 목록을 불러오지 못했습니다.")); }
      setLoading(false);
    })();
  }, []);

  const load = useCallback(async (id: string, last: string) => {
    setLoading(true); setError("");
    try {
      const j = await hrApi<SevBundle>(`/api/hr/severance?employee=${id}${last ? `&last=${last}` : ""}`);
      setB(j); setLastDay(j.last_day); setOver({}); setBonusOver(null);
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "퇴직금 자료를 불러오지 못했습니다."));
    }
    setLoading(false);
  }, []);

  function pick(id: string) {
    setEmployeeId(id); setB(null); setBonusNames(new Set()); setLeavePay("");
    load(id, "");
  }
  function changeLastDay(v: string) {
    setLastDay(v);
    if (isDate(v) && employeeId) load(employeeId, v);
  }

  const options: ComboOption[] = useMemo(() => picks.map((e) => {
    const birth = e.birth_date || "";
    return { id: e.id, label: pickLabel(e), sub: [birth, e.workplace, e.dept, e.position].filter(Boolean).join(" · "), extra: birth ? `${birth.replace(/-/g, "")} ${birth.replace(/-/g, "").slice(2)}` : "" };
  }), [picks]);
  const picked = picks.find((e) => e.id === employeeId);

  const view = useMemo(() => {
    if (!b) return null;
    const win = severanceWindow(b.last_day, b.employee.hire_date);
    const monthOf = new Map(b.months.map((m) => [m.month, m]));
    const segs = win.segments.map((seg) => {
      const auto = segmentAuto(seg, monthOf.get(seg.month), bonusNames);
      const typed = over[seg.from];
      const edited = typed != null && typed !== "" && Number(typed) !== auto.amount;
      return { ...seg, auto, edited, amount: typed != null && typed !== "" ? Number(typed) || 0 : auto.amount, typed: typed ?? String(auto.amount) };
    });
    const bonusAuto = bonusTotal(b.months, bonusNames);
    const bonusYear = bonusOver != null ? Number(bonusOver) || 0 : bonusAuto;
    const serviceDays = dayCount(b.employee.hire_date, b.last_day);
    const result = calcSeverance({ segments: segs, bonusYear, leavePay: Number(leavePay) || 0, serviceDays, ordinaryDaily: b.ordinary.daily, weeklyHours: b.weekly_hours });
    return { win, segs, cands: bonusCandidates(b.months), bonusAuto, bonusYear, serviceDays, result };
  }, [b, bonusNames, over, bonusOver, leavePay]);

  function toggleBonus(name: string) {
    setBonusNames((p) => { const n = new Set(p); if (n.has(name)) n.delete(name); else n.add(name); return n; });
    setBonusOver(null);
  }

  const e = b?.employee;
  const r = view?.result;
  // 계산 과정 — 화면과 산정서가 같은 줄을 쓴다
  const steps: [string, string, string][] = view && r && b ? [
    ["퇴직 전 3개월 임금총액", won(r.wage3m), `${view.win.from} ~ ${view.win.to} · ${r.days3m}일`],
    ["상여금·연차수당 가산", won(r.added), `(연간 상여금 ${won(view.bonusYear)} + 연차수당 ${won(Number(leavePay) || 0)}) × 3/12`],
    ["1일 평균임금", money2(r.avgDaily), `(${won(r.wage3m)} + ${won(r.added)}) ÷ ${r.days3m}일`],
    ["1일 통상임금", b.ordinary.daily ? won(b.ordinary.daily) : "", b.ordinary.calc],
    ["적용한 1일 임금", r.usedOrdinary ? won(r.usedDaily) : money2(r.usedDaily), r.usedOrdinary ? "평균임금이 통상임금보다 적어 통상임금을 씁니다" : "평균임금"],
    ["재직일수", `${numText(view.serviceDays)}일`, `${b.employee.hire_date} ~ ${b.last_day}`],
    ["퇴직금", won(r.severance), `${r.usedOrdinary ? won(r.usedDaily) : money2(r.usedDaily)} × 30 × ${numText(view.serviceDays)}일 ÷ 365 (원 미만 올림)`],
  ] : [];

  return (
    <div className="b2b-container">
      <style>{`@media print { @page { size: A4 portrait; margin: 14mm; } }`}</style>
      <header className="b2b-page-head hr-noprint">
        <div><h1 className="b2b-page-title">퇴직금</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={() => window.print()} disabled={!view}>퇴직금 산정서 인쇄</button>
        </div>
      </header>

      <div className="hr-filters hr-noprint">
        <div className="hr-sev-pick">
          <Combobox value={picked ? pickLabel(picked) : ""} options={options} onSelect={(o) => pick(o.id)} placeholder="이름·생년월일로 찾기" emptyText="일치하는 직원이 없습니다" ariaLabel="직원" />
        </div>
        {b && (
          <label className="hr-sev-last">
            <span>마지막 근무일</span>
            <input type="date" className="b2b-input" value={lastDay} min={b.employee.hire_date} onChange={(ev) => changeLastDay(ev.target.value)} aria-label="마지막 근무일" />
          </label>
        )}
      </div>

      {error && <div className="b2b-error hr-noprint" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading hr-noprint">불러오는 중...</div> : !employeeId ? (
        <div className="b2b-empty hr-noprint">{picks.length === 0 ? "등록된 직원이 없습니다." : "직원을 고르세요."}</div>
      ) : !b || !view || !r || !e ? null : (
        <div className="hr-noprint">
          {r.reasons.map((t) => <div key={t} className="sm-warn">{t}</div>)}
          <div className="hr-tiles">
            {([["재직일수", `${numText(view.serviceDays)}일`, `${e.hire_date} ~ ${b.last_day}`], ["3개월 임금총액", numText(r.wage3m), `${r.days3m}일`],
              ["1일 평균임금", r.avgDaily.toLocaleString("ko-KR", { maximumFractionDigits: 2 }), r.usedOrdinary ? "통상임금보다 적음" : ""],
              ["1일 통상임금", b.ordinary.daily ? numText(b.ordinary.daily) : "", ""], ["퇴직금", numText(r.severance), r.eligible ? "" : "지급 의무 없음(참고 금액)"]] as const).map(([label, value, hint]) => (
              <div key={label} className="b2b-stat-card">
                <div className="b2b-stat-card-label">{label}</div>
                <div className="b2b-stat-card-value">{value}</div>
                {hint && <div className="b2b-stat-card-hint">{hint}</div>}
              </div>
            ))}
          </div>

          <section className="hr-sec">
            <div className="hr-sec-head"><h2>평균임금 산정 기간</h2><span className="sm-muted">{view.win.from} ~ {view.win.to} · {view.win.days}일</span></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table hr-table">
                <thead><tr><th>기간</th><th className="num">날수</th><th className="num">임금(원)</th><th>채운 근거</th></tr></thead>
                <tbody>
                  {view.segs.map((s) => (
                    <tr key={s.from}>
                      <td>{s.from} ~ {s.to}</td>
                      <td className="num">{s.days}</td>
                      <td className="num">
                        <input className="b2b-input num hr-sev-amount" inputMode="numeric" value={numText(Number(s.typed) || 0)} aria-label={`${s.from} ~ ${s.to} 임금`}
                          onChange={(ev) => setOver((p) => ({ ...p, [s.from]: digits(ev.target.value) }))} />
                      </td>
                      <td className="hr-pay-calc">{s.edited ? `직접 넣음 (자동 ${won(s.auto.amount)} — ${s.auto.source})` : s.auto.source}</td>
                    </tr>
                  ))}
                  <tr className="hr-pay-sum"><td>합계</td><td className="num">{r.days3m}</td><td className="num">{numText(r.wage3m)}</td><td></td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="hr-sec">
            <div className="hr-sec-head"><h2>상여금·연차수당</h2></div>
            {view.cands.length > 0 && (
              <div className="hr-checks hr-sev-cands" role="group" aria-label="연간 상여금으로 옮길 항목">
                {view.cands.map((c) => (
                  <label key={c.name}>
                    <input type="checkbox" className="b2b-checkbox" checked={bonusNames.has(c.name)} onChange={() => toggleBonus(c.name)} />
                    {c.name} {won(c.total)} · {c.count}회
                  </label>
                ))}
              </div>
            )}
            <div className="hr-form">
              <section className="hr-form-sec">
                <label className="b2b-field">
                  <span className="b2b-field-label">연간 상여금</span>
                  <input className="b2b-input num" inputMode="numeric" value={numText(view.bonusYear)} onChange={(ev) => setBonusOver(digits(ev.target.value))} />
                </label>
                <label className="b2b-field">
                  <span className="b2b-field-label">연차수당</span>
                  <input className="b2b-input num" inputMode="numeric" value={leavePay === "" ? "" : numText(Number(leavePay) || 0)} placeholder="0" onChange={(ev) => setLeavePay(digits(ev.target.value))} />
                </label>
              </section>
            </div>
          </section>

          <section className="hr-sec">
            <div className="hr-sec-head"><h2>계산</h2></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table hr-table">
                <thead><tr><th>항목</th><th className="num">금액</th><th>계산 방법</th></tr></thead>
                <tbody>
                  {steps.map(([k, v, how], i) => (
                    <tr key={k} className={i === steps.length - 1 ? "hr-pay-sum" : ""}><td>{k}</td><td className="num">{v}</td><td className="hr-pay-calc">{how}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {b && view && r && e && (
        <div className="hr-print-only">
          <div className="hr-print-head"><h1>퇴직금 산정서</h1><span>{e.workplace}</span></div>
          <table className="hr-print-table hr-sev-print">
            <tbody>
              <tr><th>성명</th><td>{e.name}</td><th>생년월일</th><td>{e.birth_date || ""}</td><th>부서·직위</th><td>{[e.dept, e.position].filter(Boolean).join(" ")}</td></tr>
              <tr><th>입사일</th><td>{e.hire_date}</td><th>마지막 근무일</th><td>{b.last_day}</td><th>재직일수</th><td>{numText(view.serviceDays)}일</td></tr>
            </tbody>
          </table>
          <table className="hr-print-table hr-sev-print">
            <thead><tr><th>평균임금 산정 기간</th><th className="num">날수</th><th className="num">임금(원)</th><th>근거</th></tr></thead>
            <tbody>
              {view.segs.map((s) => <tr key={s.from}><td>{s.from} ~ {s.to}</td><td className="num">{s.days}</td><td className="num">{numText(s.amount)}</td><td>{s.edited ? "직접 넣음" : s.auto.source}</td></tr>)}
              <tr className="hr-print-week"><td>합계</td><td className="num">{r.days3m}</td><td className="num">{numText(r.wage3m)}</td><td></td></tr>
            </tbody>
          </table>
          <table className="hr-print-table hr-sev-print">
            <thead><tr><th>항목</th><th className="num">금액</th><th>계산 방법</th></tr></thead>
            <tbody>
              {steps.map(([k, v, how], i) => <tr key={k} className={i === steps.length - 1 ? "hr-print-week" : ""}><td>{k}</td><td className="num">{v}</td><td>{how}</td></tr>)}
            </tbody>
          </table>
          {r.reasons.map((t) => <p key={t} className="hr-sev-print-note">{t}</p>)}
        </div>
      )}
    </div>
  );
}
