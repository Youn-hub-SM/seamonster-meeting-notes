"use client";

// 급여 — 한 사업장의 한 달: 직원마다 한 줄(시간·지급·공제·실수령). 줄을 누르면 항목별 금액과 계산 방법을 보고 고친다.
//  작성 중에는 근무대장·임금·요율로 그때그때 계산해 보여 주고(hr-pay.ts, 서버도 같은 함수), [확정]하면 그 금액이 굳는다.
//  급여대장(가로)·급여명세서(한 사람 한 장) 인쇄, 급여대장 엑셀.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { isDate, numText, todayKst } from "@/app/lib/hr";
import { hoursText, isMonth, shiftMonth, type RosterLog } from "@/app/lib/hr-work";
import {
  SYSTEM_DEDUCT, SYSTEM_PAY, computePay, defaultPayDate, emptyInputs, initialInputs, itemAmount, normalizeInputs, snapshotOf, sumResults,
  type LineInputs, type PayBundle, type PayItemDef, type PayLineItem, type PayResult, type PaySnapshot, type TaxTable,
} from "@/app/lib/hr-pay";
import { HrApiError, errText, hrApi, hrDownload } from "../api";
import ExcelImport from "../ExcelImport";

type RowView = { id: string; snap: PaySnapshot; result: PayResult; memo: string };

// 키 순서와 상관없이 같은 내용이면 같은 글자가 되게(저장한 뒤 고친 것이 있는지 비교)
const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as object).sort(([a], [c]) => (a < c ? -1 : 1))) : val);
const won = (n: number) => numText(n);
const monthTitle = (m: string) => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5))}월`;
const wageLabel = (r: PayResult) => (r.basis.wage ? `${r.basis.pay_type === "hourly" ? "시급" : "월급"} ${won(r.basis.wage)}` : r.basis.pay_type === "hourly" ? "시급" : "월급");
const extraSum = (r: PayResult, kind: "pay" | "deduct") => r.items.filter((i) => i.kind === kind && i.code.startsWith("x:")).reduce((t, i) => t + i.amount, 0);
const shown = (r: PayResult, kind: "pay" | "deduct") => r.items.filter((i) => i.kind === kind && (i.amount !== 0 || i.edited));

export default function HrPayPage() {
  return (
    <Suspense fallback={<div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>}>
      <PayMain />
    </Suspense>
  );
}

function PayMain() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const qMonth = params.get("month") || "";
  const month = isMonth(qMonth) ? qMonth : todayKst().slice(0, 7);
  const qWp = params.get("workplace") || "";

  const [b, setB] = useState<PayBundle | null>(null);
  const [inputs, setInputs] = useState<Record<string, LineInputs>>({});
  const [payDate, setPayDate] = useState("");
  const [tax, setTax] = useState<TaxTable | null>(null);
  const [savedFp, setSavedFp] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [printMode, setPrintMode] = useState<string | null>(null); // "ledger" | "slips" | "slip:<직원 id>"
  const [aff, setAff] = useState("");                               // 소속으로 좁혀 보기("" = 모든 소속)
  const [importOpen, setImportOpen] = useState(false);              // 엑셀 올리기 창

  const adopt = useCallback((j: PayBundle) => {
    const wp = j.workplaces.find((w) => w.id === j.workplace_id);
    const pd = j.payroll?.pay_date || (wp ? defaultPayDate(j.month, wp.payday) : "");
    const active = j.items.filter((i) => i.active);
    const savedOf = new Map(j.lines.map((l) => [l.employee_id, l]));
    const inp: Record<string, LineInputs> = {};
    for (const e of j.employees) {
      const s = savedOf.get(e.id);
      inp[e.id] = s ? normalizeInputs(s.inputs, active) : initialInputs(active, j.fixed[e.id]);
    }
    setB(j); setInputs(inp); setPayDate(pd); setTax(j.tax); setSavedFp(stable([pd, inp]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      adopt(await hrApi<PayBundle>(`/api/hr/payroll?month=${month}${qWp ? `&workplace=${qWp}` : ""}`));
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "급여를 불러오지 못했습니다."));
    }
    setLoading(false);
  }, [month, qWp, adopt]);
  useEffect(() => { load(); }, [load]);

  const wp = b?.workplaces.find((w) => w.id === b.workplace_id) || null;
  const confirmed = b?.payroll?.status === "confirmed";
  const activeItems = useMemo(() => (b?.items || []).filter((i) => i.active), [b]);

  const rows: RowView[] = useMemo(() => {
    if (!b || !wp) return [];
    if (confirmed) return b.lines.filter((l) => l.result).map((l) => ({ id: l.employee_id, snap: l.snapshot, result: l.result as PayResult, memo: l.inputs?.memo || "" }));
    if (!isDate(payDate)) return [];
    const logsOf = new Map<string, RosterLog[]>();
    for (const l of b.logs) { if (!logsOf.has(l.employee_id)) logsOf.set(l.employee_id, []); logsOf.get(l.employee_id)!.push(l); }
    return b.employees.map((e) => {
      const inp = inputs[e.id] || emptyInputs();
      return { id: e.id, snap: snapshotOf(e), memo: inp.memo || "", result: computePay({ e, wp, logs: logsOf.get(e.id) || [], month: b.month, payDate, rates: b.rates, tax, items: activeItems, inputs: inp }) };
    });
  }, [b, wp, confirmed, payDate, inputs, tax, activeItems]);
  // 소속으로 좁혀 보기 — 화면·합계·인쇄·엑셀만 좁힌다. 저장·확정은 늘 그 사업장 전원(rows)에 한다.
  const affOf = useMemo(() => b?.affiliations || {}, [b]);
  const affNames = useMemo(() => [...new Set(rows.map((r) => affOf[r.id] || "").filter(Boolean))].sort((x, y) => x.localeCompare(y, "ko")), [rows, affOf]);
  const affOn = affNames.includes(aff) ? aff : "";
  const view = useMemo(() => (affOn ? rows.filter((r) => (affOf[r.id] || "") === affOn) : rows), [rows, affOf, affOn]);
  const totals = useMemo(() => sumResults(view.map((r) => r.result)), [view]);
  const allTotals = useMemo(() => sumResults(rows.map((r) => r.result)), [rows]);
  const employer = useMemo(() => view.reduce((t, r) => ({
    pension: t.pension + r.result.employer.pension, health: t.health + r.result.employer.health, ltc: t.ltc + r.result.employer.ltc,
    employment: t.employment + r.result.employer.employment, accident: t.accident + r.result.employer.accident,
  }), { pension: 0, health: 0, ltc: 0, employment: 0, accident: 0 }), [view]);
  const warnCount = rows.reduce((t, r) => t + r.result.warnings.length, 0);

  // 고친 것이 있는가 / 저장한 적이 없는가 / 저장한 뒤 근무대장·임금·요율이 바뀌어 금액이 달라졌는가
  const edited = !confirmed && !!b && stable([payDate, inputs]) !== savedFp;
  const unsaved = !confirmed && !!b && !b.payroll && rows.length > 0;
  const stale = useMemo(() => {
    if (!b || confirmed || !b.payroll || edited) return false;
    const savedOf = new Map(b.lines.map((l) => [l.employee_id, l.result]));
    return rows.length !== b.lines.length || rows.some((r) => { const s = savedOf.get(r.id); return !s || s.net_pay !== r.result.net_pay || s.pay_total !== r.result.pay_total || s.deduct_total !== r.result.deduct_total; });
  }, [b, confirmed, edited, rows]);
  const needSave = edited || unsaved || stale;

  useEffect(() => {
    if (!edited) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);
  useEffect(() => {
    const clear = () => setPrintMode(null);
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  async function go(m: string, w?: string) {
    if (edited && !(await confirm({ title: "저장하지 않은 변경", body: "이 달에서 고친 내용이 사라집니다.", action: "저장하지 않고 이동" }))) return;
    const wid = w ?? b?.workplace_id ?? "";
    router.push(`/hr/pay?month=${m}${wid ? `&workplace=${wid}` : ""}`);
  }

  // 지급일을 바꾸면 그날에 유효한 간이세액표로 다시 본다(자녀 공제는 요율표에서 화면이 바로 찾는다)
  async function changePayDate(v: string) {
    setPayDate(v);
    if (!isDate(v)) return;
    try {
      const j = await hrApi<{ table: TaxTable | null }>(`/api/hr/tax-table?on=${v}`);
      setTax(j.table);
    } catch { /* 저장할 때 서버가 그날의 표로 다시 계산한다 */ }
  }

  async function save(confirmIt: boolean) {
    if (!b || !wp) return;
    if (!isDate(payDate)) { toast.error("지급일을 입력하세요"); return; }
    if (confirmIt) {
      const ok = await confirm({
        title: `${monthTitle(b.month)} 급여 확정`,
        body: `${affOn ? "소속과 상관없이 이 사업장 전원 " : ""}${rows.length}명, 실수령 합계 ${won(allTotals.net_pay)}원. 확정하면 이 달의 급여와 근무대장을 고칠 수 없습니다.${warnCount ? ` 확인할 것이 ${warnCount}건 남아 있습니다.` : ""}`,
        action: "급여 확정",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      adopt(await hrApi<PayBundle>("/api/hr/payroll", "PUT", { workplace_id: b.workplace_id, month: b.month, pay_date: payDate, inputs, confirm: confirmIt }));
      toast.success(confirmIt ? `${monthTitle(b.month)} 급여를 확정했습니다` : `${monthTitle(b.month)} 급여를 저장했습니다`);
    } catch (err) { toast.error(errText(err, confirmIt ? "급여를 확정하지 못했습니다." : "급여를 저장하지 못했습니다.")); }
    setBusy(false);
  }

  async function unconfirm() {
    if (!b?.payroll) return;
    const ok = await confirm({ title: `${monthTitle(b.month)} 확정 취소`, body: "작성 중으로 돌아가 금액을 지금의 근무대장·임금·요율로 다시 계산합니다. 근무대장 잠금도 풀립니다.", action: "확정 취소" });
    if (!ok) return;
    setBusy(true);
    try {
      adopt(await hrApi<PayBundle>("/api/hr/payroll", "POST", { action: "unconfirm", id: b.payroll.id }));
      toast.success("확정을 취소했습니다");
    } catch (err) { toast.error(errText(err, "확정을 취소하지 못했습니다.")); }
    setBusy(false);
  }

  async function excel() {
    if (!b) return;
    if (needSave) { toast.error("변경을 저장한 뒤 내려받으세요"); return; }
    try { await hrDownload("/api/hr/payroll/export", { workplace_id: b.workplace_id, month: b.month, affiliation: affOn || undefined }, `payroll-${b.month}.xlsx`); }
    catch (err) { toast.error(errText(err, "급여대장을 내보내지 못했습니다.")); }
  }
  // 엑셀 올리기 — 내려받은 급여대장에서 금액을 고쳐 다시 올린다. 저장된 급여와 대조하므로 저장하지 않은 것이 있으면 먼저 저장한다.
  function openImport() {
    if (needSave) { toast.error("변경을 저장한 뒤 올리세요"); return; }
    setEditing(null); setImportOpen(true);
  }
  function print(mode: string) {
    if (needSave) { toast.error("변경을 저장한 뒤 인쇄하세요"); return; }
    setEditing(null); setPrintMode(mode);
    setTimeout(() => window.print(), 200); // 창이 닫히고 인쇄용 표가 그려진 뒤
  }

  const patch = (id: string, fn: (x: LineInputs) => LineInputs) => setInputs((p) => ({ ...p, [id]: fn(p[id] || emptyInputs()) }));

  const editRow = editing ? rows.find((r) => r.id === editing) || null : null;
  const slipRows = printMode === "slips" ? view : printMode?.startsWith("slip:") ? rows.filter((r) => r.id === printMode.slice(5)) : [];
  const multiWp = (b?.workplaces.length || 0) > 1;
  const showAff = affNames.length > 0 && !affOn;   // 소속 열: 소속을 쓰는 사업장에서, 하나를 고르지 않았을 때

  return (
    <div className="b2b-container">
      <style>{`@media print { @page { size: A4 ${printMode === "ledger" ? "landscape" : "portrait"}; margin: 10mm; } }`}</style>

      <header className="b2b-page-head hr-noprint">
        <div><h1 className="b2b-page-title">급여</h1></div>
        <div className="b2b-page-actions">
          <Link href="/hr/pay/items" prefetch={false} className="b2b-btn-secondary">급여 항목</Link>
          <button type="button" className="b2b-btn-secondary" onClick={excel} disabled={busy || rows.length === 0}>엑셀 내려받기</button>
          {!confirmed && <button type="button" className="b2b-btn-secondary" onClick={openImport} disabled={busy || rows.length === 0}>엑셀 올리기</button>}
          <button type="button" className="b2b-btn-secondary" onClick={() => print("ledger")} disabled={busy || rows.length === 0}>급여대장 인쇄</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => print("slips")} disabled={busy || rows.length === 0}>명세서 인쇄</button>
          {confirmed ? (
            <button type="button" className="b2b-btn-secondary" onClick={unconfirm} disabled={busy}>확정 취소</button>
          ) : (
            <>
              <button type="button" className="b2b-btn-secondary" onClick={() => save(false)} disabled={busy || !needSave || rows.length === 0}>{busy ? "저장 중..." : "변경 저장"}</button>
              <button type="button" className="b2b-btn-primary" onClick={() => save(true)} disabled={busy || rows.length === 0}>급여 확정</button>
            </>
          )}
        </div>
      </header>

      <div className="hr-filters hr-noprint">
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(month, -1))}>이전 달</button>
        <input type="month" className="b2b-input hr-month" value={month} aria-label="귀속월" onChange={(e) => { if (isMonth(e.target.value)) go(e.target.value); }} />
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(month, 1))}>다음 달</button>
        {multiWp && b && (
          <select className="b2b-input" value={b.workplace_id} onChange={(e) => go(month, e.target.value)} aria-label="사업장">
            {b.workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {affNames.length > 0 && (
          <select className="b2b-input" value={affOn} onChange={(e) => setAff(e.target.value)} aria-label="소속">
            <option value="">모든 소속</option>
            {affNames.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {b && wp && (
          <label className="hr-pay-date">
            <span>지급일</span>
            <input type="date" className="b2b-input" value={confirmed ? b.payroll?.pay_date || "" : payDate} disabled={confirmed || busy} onChange={(e) => changePayDate(e.target.value)} />
          </label>
        )}
        {b && wp && rows.length > 0 && (confirmed
          ? <span className="b2b-status-pill hr-pill-ok">확정{b.payroll?.confirmed_by ? ` · ${b.payroll.confirmed_by}` : ""}</span>
          : <span className="b2b-status-pill hr-pill-off">{needSave ? "작성 중 · 저장 전" : "작성 중"}</span>)}
      </div>

      {error && <div className="b2b-error hr-noprint" role="alert">{error}</div>}
      {!loading && !error && b && !confirmed && rows.length > 0 && !tax && (
        <div className="sm-warn hr-noprint">지급일에 쓸 간이세액표가 없습니다. 요율 화면에서 올리기 전에는 소득세가 자동으로 나오지 않습니다.</div>
      )}
      {stale && <div className="sm-warn hr-noprint">저장한 뒤 근무대장·임금·요율이 바뀌어 금액이 달라졌습니다. [변경 저장]을 누르면 지금 금액으로 저장합니다.</div>}

      {loading ? <div className="b2b-loading hr-noprint">불러오는 중...</div> : error || !b ? null : !wp ? (
        <div className="b2b-empty hr-noprint">
          등록된 사업장이 없습니다.
          <div className="b2b-empty-action"><Link href="/hr/settings" className="b2b-btn-secondary">사업장 등록</Link></div>
        </div>
      ) : rows.length === 0 ? (
        <div className="b2b-empty hr-noprint">이 달에 재직한 직원이 없습니다.</div>
      ) : (
        <>
          <div className="hr-tiles hr-noprint">
            {([["인원", `${view.length}명`], ["지급 합계", won(totals.pay_total)], ["공제 합계", won(totals.deduct_total)], ["실수령 합계", won(totals.net_pay)], ["회사 부담 4대보험", won(totals.employer)]] as const).map(([label, value]) => (
              <div key={label} className="b2b-stat-card">
                <div className="b2b-stat-card-label">{label}</div>
                <div className="b2b-stat-card-value">{value}</div>
              </div>
            ))}
          </div>

          <div className="b2b-table-wrap hr-screen-only">
            <table className="b2b-table is-clickable hr-table">
              <thead>
                <tr>
                  {showAff && <th>소속</th>}
                  <th>사번</th><th>성명</th><th>임금</th><th className="num">근무 일수</th><th className="num">근무 시간</th><th className="num">연장</th><th className="num">야간</th><th className="num">휴일 근무</th>
                  <th className="num">지급 합계</th><th className="num">공제 합계</th><th className="num">실수령액</th><th>확인할 것</th>
                </tr>
              </thead>
              <tbody>
                {view.map(({ id, snap, result: r }) => (
                  <tr key={id} onClick={() => setEditing(id)} tabIndex={0} role="button" onKeyDown={(ev) => { if (ev.key === "Enter") setEditing(id); }}>
                    {showAff && <td>{affOf[id] || ""}</td>}
                    <td className="hr-mono">{snap.emp_no}</td>
                    <td><strong>{snap.name}</strong>{r.items.some((i) => i.edited) && <span className="b2b-status-pill hr-pill-off" style={{ marginLeft: 8 }}>고침</span>}</td>
                    <td>{wageLabel(r)}</td>
                    <td className="num">{r.basis.pay_type === "hourly" ? r.basis.workDays : ""}</td>
                    <td className="num">{r.basis.pay_type === "hourly" ? hoursText(r.basis.worked) : ""}</td>
                    <td className="num">{r.basis.pay_type === "hourly" ? hoursText(r.basis.overtime) : ""}</td>
                    <td className="num">{r.basis.pay_type === "hourly" ? hoursText(r.basis.night) : ""}</td>
                    <td className="num">{r.basis.pay_type === "hourly" ? hoursText(r.basis.holiday) : ""}</td>
                    <td className="num">{won(r.pay_total)}</td>
                    <td className="num">{won(r.deduct_total)}</td>
                    <td className="num"><strong>{won(r.net_pay)}</strong></td>
                    <td>{r.warnings.length > 0 ? <span className="hr-bad">{r.warnings[0]}{r.warnings.length > 1 ? ` 외 ${r.warnings.length - 1}건` : ""}</span> : ""}</td>
                  </tr>
                ))}
                <tr className="hr-pay-sum">
                  <td colSpan={showAff ? 9 : 8}>합계 {view.length}명</td>
                  <td className="num">{won(totals.pay_total)}</td><td className="num">{won(totals.deduct_total)}</td><td className="num">{won(totals.net_pay)}</td><td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {importOpen && b && (
        <ExcelImport title={`급여 엑셀 올리기 — ${monthTitle(b.month)}${wp ? ` ${wp.name}` : ""}`} endpoint="/api/hr/payroll/import" extra={{ workplace_id: b.workplace_id, month: b.month }}
          unit="명" applyWord="저장" blockOnError templateLabel="이 달 급여대장 내려받기"
          onTemplate={() => hrDownload("/api/hr/payroll/export", { workplace_id: b.workplace_id, month: b.month }, `payroll-${b.month}.xlsx`)}
          onClose={() => setImportOpen(false)}
          onDone={(r) => { load(); toast.success(`${r.counts.update}명의 급여를 고쳐 저장했습니다`); }} />
      )}
      {editRow && b && (
        <LineEditor row={editRow} month={b.month} items={activeItems} readOnly={!!confirmed}
          input={confirmed ? { ...emptyInputs(), memo: editRow.memo } : inputs[editRow.id] || emptyInputs()}
          onPatch={(fn) => patch(editRow.id, fn)} onClose={() => setEditing(null)} onPrint={() => print(`slip:${editRow.id}`)} />
      )}

      {/* 인쇄용 — 화면에는 보이지 않는다 */}
      {b && wp && printMode === "ledger" && (
        <div className="hr-print-only">
          <div className="hr-print-head">
            <h1>급여대장 {monthTitle(b.month)}</h1>
            <span>{wp.name}{affOn ? ` · ${affOn}` : ""} · 지급일 {confirmed ? b.payroll?.pay_date : payDate} · {view.length}명 · {confirmed ? "확정" : "작성 중"}</span>
          </div>
          <table className="hr-print-table hr-pay-ledger">
            <thead>
              <tr>
                <th>사번</th><th>성명</th><th>생년월일</th><th>입사일</th><th>업무</th><th>임금</th>
                <th>근로 일수</th><th>근로 시간</th><th>연장</th><th>야간</th><th>휴일</th>
                <th>기본급</th><th>주휴</th><th>연장</th><th>야간</th><th>휴일</th><th>연차·유급</th><th>그 밖의 지급</th><th>지급 합계</th>
                <th>국민연금</th><th>건강보험</th><th>장기요양</th><th>고용보험</th><th>소득세</th><th>지방소득세</th><th>그 밖의 공제</th><th>공제 합계</th><th>실수령액</th>
              </tr>
            </thead>
            <tbody>
              {view.map(({ id, snap, result: r }) => (
                <tr key={id}>
                  <td>{snap.emp_no}</td><td>{snap.name}</td><td>{snap.birth_date || ""}</td><td>{snap.hire_date || ""}</td><td>{snap.job || ""}</td><td>{wageLabel(r)}</td>
                  <td className="num">{r.basis.workDays}</td><td className="num">{hoursText(r.basis.worked)}</td><td className="num">{hoursText(r.basis.overtime)}</td><td className="num">{hoursText(r.basis.night)}</td><td className="num">{hoursText(r.basis.holiday)}</td>
                  {SYSTEM_PAY.map((c) => <td key={c} className="num">{won(itemAmount(r, c))}</td>)}
                  <td className="num">{won(extraSum(r, "pay"))}</td><td className="num">{won(r.pay_total)}</td>
                  {SYSTEM_DEDUCT.map((c) => <td key={c} className="num">{won(itemAmount(r, c))}</td>)}
                  <td className="num">{won(extraSum(r, "deduct"))}</td><td className="num">{won(r.deduct_total)}</td><td className="num">{won(r.net_pay)}</td>
                </tr>
              ))}
              <tr className="hr-print-week">
                <td colSpan={11}>합계 {view.length}명</td>
                {SYSTEM_PAY.map((c) => <td key={c} className="num">{won(totals.byCode[c] || 0)}</td>)}
                <td className="num">{won(view.reduce((t, r) => t + extraSum(r.result, "pay"), 0))}</td><td className="num">{won(totals.pay_total)}</td>
                {SYSTEM_DEDUCT.map((c) => <td key={c} className="num">{won(totals.byCode[c] || 0)}</td>)}
                <td className="num">{won(view.reduce((t, r) => t + extraSum(r.result, "deduct"), 0))}</td><td className="num">{won(totals.deduct_total)}</td><td className="num">{won(totals.net_pay)}</td>
              </tr>
            </tbody>
          </table>
          <table className="hr-print-table hr-print-sum hr-pay-ledger">
            <thead><tr><th>회사 부담</th><th>국민연금</th><th>건강보험</th><th>장기요양</th><th>고용보험</th><th>산재보험</th><th>합계</th></tr></thead>
            <tbody><tr>
              <td>4대보험</td><td className="num">{won(employer.pension)}</td><td className="num">{won(employer.health)}</td><td className="num">{won(employer.ltc)}</td>
              <td className="num">{won(employer.employment)}</td><td className="num">{won(employer.accident)}</td><td className="num">{won(totals.employer)}</td>
            </tr></tbody>
          </table>
        </div>
      )}
      {b && wp && slipRows.length > 0 && (
        <div className="hr-print-only">
          {slipRows.map(({ id, snap, result: r }) => (
            <PaySlip key={id} snap={snap} r={r} wpName={wp.name} month={b.month} payDate={(confirmed ? b.payroll?.pay_date : payDate) || ""} />
          ))}
        </div>
      )}
    </div>
  );
}

// 급여명세서 한 장(인쇄) — 위: 사람·실수령액 / 가운데: 지급 내역 | 공제 내역(항목 아래 작은 글씨로 계산 방법) / 아래: 근무 산출근거.
//  임금명세서에 있어야 하는 것(성명·생년월일·사번, 지급일, 총액, 항목별 금액과 계산 방법, 공제 내역)은 모두 이 장에 있다.
function PaySlip({ snap, r, wpName, month, payDate }: { snap: PaySnapshot; r: PayResult; wpName: string; month: string; payDate: string }) {
  const who = [snap.name, snap.birth_date || "", snap.emp_no, [snap.dept, snap.position].filter(Boolean).join(" "), snap.hire_date ? `입사 ${snap.hire_date}` : "", wpName].filter(Boolean);
  const basis: [string, string][] = r.basis.pay_type === "hourly" ? [
    ["근무 일수", `${r.basis.workDays}일`], ["근무 시간", `${hoursText(r.basis.worked)}시간`],
    ["연장", `${hoursText(r.basis.overtime)}시간`], ["야간", `${hoursText(r.basis.night)}시간`],
    ["휴일 근무", `${hoursText(r.basis.holiday)}시간`], ["주휴", `${hoursText(r.basis.weeklyHours)}시간`],
    ["연차·유급 휴일", `${hoursText(r.basis.paidHours)}시간`], ["시급", `${won(r.basis.wage)}원`],
  ] : [];
  const items = (kind: "pay" | "deduct") => shown(r, kind).map((i) => (
    <li key={i.code}>
      <div><span>{i.name}{i.exempt > 0 && <em>비과세</em>}</span>{i.calc && i.calc !== "비과세" && <small>{i.calc}</small>}</div>
      <b>{won(i.amount)}원</b>
    </li>
  ));
  return (
    <section className="hr-slip">
      <header className="hr-slip-head">
        <h1>급여명세서</h1>
        <div className="hr-slip-who">{who.map((t, i) => <span key={i}>{t}</span>)}</div>
      </header>
      <div className="hr-slip-net">
        <span className="hr-slip-net-label">실수령액<small>{monthTitle(month)}분 · {payDate} 지급</small></span>
        <i aria-hidden="true" />
        <strong>{won(r.net_pay)}원</strong>
      </div>
      <div className="hr-slip-cols">
        <div>
          <div className="hr-slip-col-head"><h2>지급 내역</h2><strong>{won(r.pay_total)}원</strong></div>
          <ul>{items("pay")}</ul>
          {r.exempt_total > 0 && <p className="hr-slip-note">비과세 {won(r.exempt_total)}원 · 과세 {won(r.taxable_total)}원</p>}
        </div>
        <div>
          <div className="hr-slip-col-head"><h2>공제 내역</h2><strong>{won(r.deduct_total)}원</strong></div>
          <ul>{items("deduct")}</ul>
        </div>
      </div>
      {basis.length > 0 && (
        <div className="hr-slip-basis">
          <div className="hr-slip-col-head"><h2>근무 산출근거</h2><span>{monthTitle(month)}</span></div>
          <dl className="hr-slip-kv">{basis.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </div>
      )}
    </section>
  );
}

// 한 직원의 그달 급여 — 항목별 금액과 계산 방법. 금액 칸을 고치면 그 값이 쓰이고(자동 계산값은 옆에 남는다), 비우면 자동으로 돌아간다.
function LineEditor({ row, month, items, input, readOnly, onPatch, onClose, onPrint }: {
  row: RowView; month: string; items: PayItemDef[]; input: LineInputs; readOnly: boolean;
  onPatch: (fn: (x: LineInputs) => LineInputs) => void; onClose: () => void; onPrint: () => void;
}) {
  useEscClose(onClose);
  const r = row.result;
  const byCode = new Map(r.items.map((i) => [i.code, i]));
  const digits = (s: string, neg = false) => { const t = s.replace(neg ? /[^\d-]/g : /[^\d]/g, ""); return t === "" || t === "-" ? null : Number(t); };

  const setOverride = (code: string, raw: string, auto: number | null) => onPatch((x) => {
    const n = digits(raw);
    const overrides = { ...x.overrides };
    if (n == null || n === auto) delete overrides[code]; else overrides[code] = n;
    return { ...x, overrides };
  });
  const setExtra = (d: PayItemDef, raw: string) => onPatch((x) => {
    const n = digits(raw, d.kind === "deduct");
    const extras = { ...x.extras };
    if (!n) delete extras[d.id]; else extras[d.id] = { ...extras[d.id], amount: n };
    return { ...x, extras };
  });
  const setQty = (d: PayItemDef, raw: string) => onPatch((x) => {
    const cur = x.extras[d.id];
    if (!cur) return x;
    return { ...x, extras: { ...x.extras, [d.id]: { ...cur, qty: Math.min(20, Math.max(1, digits(raw) || 1)) } } };
  });
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

  const sysRow = (i: PayLineItem) => (
    <tr key={i.code}>
      <td>{i.name}{i.edited && <span className="b2b-status-pill hr-pill-off" style={{ marginLeft: 8 }}>고침</span>}</td>
      <td className="hr-pay-calc">{i.calc}</td>
      <td className="num">
        {readOnly ? won(i.amount) : (
          <input key={`${i.code}:${i.amount}`} className="b2b-input" inputMode="numeric" defaultValue={won(i.amount)} aria-label={`${i.name} 금액`}
            onBlur={(e) => setOverride(i.code, e.target.value, i.auto)} onKeyDown={blurOnEnter} />
        )}
      </td>
    </tr>
  );
  const extraRow = (d: PayItemDef) => {
    const cur = input.extras[d.id];
    const item = byCode.get(`x:${d.id}`);
    return (
      <tr key={d.id}>
        <td>{d.name}{d.fixed && <span className="sm-faint" style={{ marginLeft: 8 }}>매월 고정</span>}</td>
        <td className="hr-pay-calc">
          {d.tax === "childcare" && cur && !readOnly ? (
            <label>6세 이하 자녀 <input key={`q:${cur.qty || 1}`} className="b2b-input hr-pay-qty" inputMode="numeric" defaultValue={String(cur.qty || 1)} aria-label="자녀 수"
              onBlur={(e) => setQty(d, e.target.value)} onKeyDown={blurOnEnter} /> 명 · {item?.calc}</label>
          ) : item?.calc || ""}
        </td>
        <td className="num">
          {readOnly ? won(item?.amount || 0) : (
            <input key={`${d.id}:${cur?.amount || 0}`} className="b2b-input" inputMode="numeric" defaultValue={cur?.amount ? won(cur.amount) : ""} placeholder="0" aria-label={`${d.name} 금액`}
              onBlur={(e) => setExtra(d, e.target.value)} onKeyDown={blurOnEnter} />
          )}
        </td>
      </tr>
    );
  };
  // 확정된 달: 저장된 줄에 있는 항목만(그때 이름 그대로). 작성 중: 지금 쓰는 항목 전부
  const savedExtra = (kind: "pay" | "deduct") => r.items.filter((i) => i.kind === kind && i.code.startsWith("x:")).map((i) => (
    <tr key={i.code}><td>{i.name}</td><td className="hr-pay-calc">{i.calc}</td><td className="num">{won(i.amount)}</td></tr>
  ));
  const basis = r.basis;

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label={`${row.snap.name} 급여`} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{row.snap.name} · {monthTitle(month)} 급여</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="hr-pay-edit">
            {basis.pay_type === "hourly" && (
              <p className="hr-rule">
                근무 {basis.workDays}일 {hoursText(basis.worked)}시간 · 연장 {hoursText(basis.overtime)} · 야간 {hoursText(basis.night)} · 휴일 근무 {hoursText(basis.holiday)} · 주휴 {hoursText(basis.weeklyHours)} · 연차·유급 휴일 {hoursText(basis.paidHours)}시간
                {basis.absentDays > 0 ? ` · 결근 ${basis.absentDays}일` : ""}
              </p>
            )}
            {r.warnings.length > 0 && <div className="sm-warn">{r.warnings.join(" · ")}</div>}

            <div className="b2b-table-wrap">
              <table className="b2b-table hr-pay-table">
                <thead><tr><th>지급</th><th>계산 방법</th><th className="num">금액(원)</th></tr></thead>
                <tbody>
                  {SYSTEM_PAY.map((c) => byCode.get(c)).filter((i): i is PayLineItem => !!i).map(sysRow)}
                  {readOnly ? savedExtra("pay") : items.filter((d) => d.kind === "pay").map(extraRow)}
                  <tr className="hr-pay-sum"><td>지급 합계</td><td className="hr-pay-calc">{r.exempt_total > 0 ? `비과세 ${won(r.exempt_total)}원 · 과세 ${won(r.taxable_total)}원` : `과세 ${won(r.taxable_total)}원`}</td><td className="num">{won(r.pay_total)}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="b2b-table-wrap">
              <table className="b2b-table hr-pay-table">
                <thead><tr><th>공제</th><th>계산 방법</th><th className="num">금액(원)</th></tr></thead>
                <tbody>
                  {SYSTEM_DEDUCT.map((c) => byCode.get(c)).filter((i): i is PayLineItem => !!i).map(sysRow)}
                  {readOnly ? savedExtra("deduct") : items.filter((d) => d.kind === "deduct").map(extraRow)}
                  <tr className="hr-pay-sum"><td>공제 합계</td><td></td><td className="num">{won(r.deduct_total)}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="hr-pay-net"><span>실수령액</span><span>{won(r.net_pay)}원</span></div>
            <label className="b2b-field">
              <span className="b2b-field-label">메모</span>
              <input className="b2b-input" value={input.memo || ""} maxLength={300} disabled={readOnly} onChange={(e) => onPatch((x) => ({ ...x, memo: e.target.value }))} />
            </label>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onPrint}>명세서 인쇄</button>
            <button type="button" className="b2b-btn-primary" onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
