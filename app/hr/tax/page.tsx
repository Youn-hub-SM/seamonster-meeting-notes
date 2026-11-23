"use client";

// 원천세 집계 — 한 해 동안 지급한 급여에서 뗀 소득세·지방소득세를 지급한 달 순으로. 세무 신고에 넘길 숫자다.
//  신고는 지급한 달 기준(다음 달 10일까지)이라 귀속월이 아니라 지급일로 묶는다. 합계에는 확정한 급여만 든다. 기준은 hr-tax.ts 머리말.

import { useCallback, useEffect, useMemo, useState } from "react";
import { numText, todayKst } from "@/app/lib/hr";
import { isFirstHalf, sumTax, type TaxBundle, type TaxRow, type TaxSum } from "@/app/lib/hr-tax";
import { HrApiError, errText, hrApi } from "../api";

const monthKo = (m: string) => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5))}월`;

export default function HrTaxPage() {
  const [year, setYear] = useState(Number(todayKst().slice(0, 4)));
  const [b, setB] = useState<TaxBundle | null>(null);
  const [wp, setWp] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setB(await hrApi<TaxBundle>(`/api/hr/tax?year=${year}`)); }
    catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "원천세 집계를 불러오지 못했습니다.")); }
    setLoading(false);
  }, [year]);
  useEffect(() => { load(); }, [load]);

  const multiWp = (b?.workplaces.length || 0) > 1;
  const wpName = useMemo(() => new Map((b?.workplaces || []).map((w) => [w.id, w.name])), [b]);
  const rows = useMemo(() => (b?.rows || []).filter((r) => !wp || r.workplace_id === wp), [b, wp]);
  const first = useMemo(() => rows.filter((r) => isFirstHalf(r.pay_month)), [rows]);
  const second = useMemo(() => rows.filter((r) => !isFirstHalf(r.pay_month)), [rows]);
  const total = useMemo(() => sumTax(rows), [rows]);
  const drafts = rows.filter((r) => r.status !== "confirmed").length;
  const showWp = multiWp && !wp;
  const lead = showWp ? 5 : 4;   // 합계 줄의 앞 칸 수(지급한 달·귀속월·[사업장]·지급일·상태)

  const line = (r: TaxRow) => (
    <tr key={r.payroll_id} className={r.status === "confirmed" ? "" : "hr-leave-dim"}>
      <td>{monthKo(r.pay_month)}</td>
      <td>{monthKo(r.month)}</td>
      {showWp && <td>{wpName.get(r.workplace_id) || ""}</td>}
      <td>{r.pay_date}</td>
      <td><span className={`b2b-status-pill ${r.status === "confirmed" ? "hr-pill-ok" : "hr-pill-off"}`}>{r.status === "confirmed" ? "확정" : "작성 중"}</span></td>
      <td className="num">{r.people}</td>
      <td className="num">{numText(r.pay_total)}</td><td className="num">{numText(r.exempt_total)}</td><td className="num">{numText(r.taxable_total)}</td>
      <td className="num">{numText(r.income_tax)}</td><td className="num">{numText(r.local_tax)}</td>
      <td>{r.due}</td>
    </tr>
  );
  const sumLine = (label: string, s: TaxSum) => (
    <tr key={label} className="hr-pay-sum">
      <td colSpan={lead}>{label}</td>
      <td className="num">{s.people}</td>
      <td className="num">{numText(s.pay_total)}</td><td className="num">{numText(s.exempt_total)}</td><td className="num">{numText(s.taxable_total)}</td>
      <td className="num">{numText(s.income_tax)}</td><td className="num">{numText(s.local_tax)}</td>
      <td></td>
    </tr>
  );
  const head = (
    <tr>
      <th>지급한 달</th><th>귀속월</th>{showWp && <th>사업장</th>}<th>지급일</th><th>상태</th><th className="num">인원</th>
      <th className="num">지급 합계</th><th className="num">비과세</th><th className="num">과세 급여</th><th className="num">소득세</th><th className="num">지방소득세</th><th>신고·납부 기한</th>
    </tr>
  );
  const body = (
    <>
      {first.map(line)}
      {first.length > 0 && sumLine("상반기 합계(1~6월 지급)", sumTax(first))}
      {second.map(line)}
      {second.length > 0 && sumLine("하반기 합계(7~12월 지급)", sumTax(second))}
      {sumLine(`${year}년 합계`, total)}
    </>
  );
  const title = `${year}년 원천세 집계${wp ? ` — ${wpName.get(wp) || ""}` : ""}`;

  return (
    <div className="b2b-container">
      <style>{`@media print { @page { size: A4 landscape; margin: 12mm; } }`}</style>
      <header className="b2b-page-head hr-noprint">
        <div><h1 className="b2b-page-title">원천세</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={() => window.print()} disabled={loading || rows.length === 0}>원천세 집계 인쇄</button>
        </div>
      </header>

      <div className="hr-filters hr-noprint">
        <button type="button" className="b2b-btn-secondary" onClick={() => setYear((y) => y - 1)}>이전 해</button>
        <strong>{year}년</strong>
        <button type="button" className="b2b-btn-secondary" onClick={() => setYear((y) => y + 1)}>다음 해</button>
        {multiWp && b && (
          <select className="b2b-input" value={wp} onChange={(e) => setWp(e.target.value)} aria-label="사업장">
            <option value="">모든 사업장</option>
            {b.workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="b2b-error hr-noprint" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading hr-noprint">불러오는 중...</div> : error || !b ? null : rows.length === 0 ? (
        <div className="b2b-empty hr-noprint">{year}년에 지급한 급여가 없습니다.</div>
      ) : (
        <div className="hr-noprint">
          {drafts > 0 && <div className="sm-warn">작성 중인 급여 {drafts}건은 합계에 넣지 않았습니다. 급여를 확정하면 들어갑니다.</div>}
          <div className="hr-tiles">
            {([["확정한 급여", `${total.payrolls}건`], ["지급 합계", numText(total.pay_total)], ["과세 급여", numText(total.taxable_total)], ["소득세", numText(total.income_tax)], ["지방소득세", numText(total.local_tax)]] as const).map(([label, value]) => (
              <div key={label} className="b2b-stat-card">
                <div className="b2b-stat-card-label">{label}</div>
                <div className="b2b-stat-card-value">{value}</div>
              </div>
            ))}
          </div>
          <div className="b2b-table-wrap">
            <table className="b2b-table hr-table"><thead>{head}</thead><tbody>{body}</tbody></table>
          </div>
        </div>
      )}

      {b && rows.length > 0 && (
        <div className="hr-print-only">
          <div className="hr-print-head"><h1>{title}</h1><span>지급한 달 기준 · 합계는 확정한 급여만 · 단위 원</span></div>
          <table className="hr-print-table hr-tax-print"><thead>{head}</thead><tbody>{body}</tbody></table>
        </div>
      )}
    </div>
  );
}
