"use client";

// 이체 파일 — 저장한 급여의 실수령액으로 국민은행 급여이체 엑셀을 만든다. 직원을 골라서 낼 수 있다(일부만 먼저 이체, 나머지는 나중에).
//  은행 양식 그대로(머리 줄 없이 은행·계좌·금액·예금주·받는분 통장표시·내 통장 메모·메모)라 은행 화면에 바로 올린다.
//  계좌번호는 이 창에서 끝 네 자리만 보이고, 전체는 내려받는 파일에만 들어간다.

import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { numText } from "@/app/lib/hr";
import type { BankLabels, BankRow } from "@/app/lib/hr-bank";
import { HrApiError, errText, hrApi, hrDownload } from "../api";

type Listing = { month: string; workplace: string; status: "draft" | "confirmed"; pay_date: string; labels: BankLabels; rows: BankRow[] };

export default function BankExport({ workplaceId, month, affiliation, onClose }: { workplaceId: string; month: string; affiliation: string; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState<BankLabels>({ recv: "", mine: "", memo: "" });
  const [q, setQ] = useState("");
  const [aff, setAff] = useState(affiliation);
  useEscClose(onClose, busy);

  useEffect(() => {
    (async () => {
      try {
        const j = await hrApi<Listing>("/api/hr/payroll/bank", "POST", { workplace_id: workplaceId, month });
        setData(j); setLabels(j.labels);
        // 처음에는 이체할 수 있는 직원을 모두 고른다(급여 화면에서 소속을 골라 두었으면 그 소속만)
        setPicked(new Set(j.rows.filter((r) => r.problems.length === 0 && (!affiliation || r.affiliation === affiliation)).map((r) => r.employee_id)));
      } catch (err) {
        if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "이체 목록을 불러오지 못했습니다."));
      }
    })();
  }, [workplaceId, month, affiliation]);

  const affNames = useMemo(() => [...new Set((data?.rows || []).map((r) => r.affiliation).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")), [data]);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (data?.rows || []).filter((r) => (!aff || r.affiliation === aff) && (!k || [r.name, r.holder, r.bank, r.affiliation].some((v) => v.toLowerCase().includes(k))));
  }, [data, q, aff]);
  const ok = (r: BankRow) => r.problems.length === 0;
  const shownOk = shown.filter(ok);
  const allShown = shownOk.length > 0 && shownOk.every((r) => picked.has(r.employee_id));
  const chosen = (data?.rows || []).filter((r) => picked.has(r.employee_id));
  const total = chosen.reduce((t, r) => t + r.amount, 0);
  const blockedCount = (data?.rows || []).filter((r) => !ok(r)).length;

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleShown = () => setPicked((p) => { const n = new Set(p); for (const r of shownOk) { if (allShown) n.delete(r.employee_id); else n.add(r.employee_id); } return n; });

  async function download() {
    if (!data || chosen.length === 0) { toast.error("이체할 직원을 고르세요"); return; }
    setBusy(true); setError("");
    try {
      await hrDownload("/api/hr/payroll/bank", { workplace_id: workplaceId, month, download: true, employee_ids: chosen.map((r) => r.employee_id), labels }, `bank-${month}.xlsx`);
      toast.success(`${chosen.length}명의 이체 파일을 내려받았습니다`);
    } catch (err) { setError(errText(err, "이체 파일을 만들지 못했습니다.")); }
    setBusy(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label="이체 파일">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">이체 파일 — {Number(month.slice(0, 4))}년 {Number(month.slice(5))}월{data ? ` ${data.workplace}` : ""}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {error && <div className="b2b-error" role="alert">{error}</div>}
          {!data && !error && <div className="b2b-loading">불러오는 중...</div>}
          {data && (
            <>
              {data.status !== "confirmed" && <div className="sm-warn">급여 확정 전입니다. 저장해 둔 금액으로 만듭니다.</div>}
              {blockedCount > 0 && <div className="sm-warn">이체할 수 없는 직원이 {blockedCount}명 있습니다. 인사대장에서 은행·계좌번호를 넣으면 고를 수 있습니다.</div>}
              <div className="hr-filters">
                <input className="b2b-input hr-bank-search" placeholder="검색" value={q} aria-label="검색" onChange={(e) => setQ(e.target.value)} />
                {affNames.length > 0 && (
                  <select className="b2b-input" value={aff} onChange={(e) => setAff(e.target.value)} aria-label="소속">
                    <option value="">모든 소속</option>
                    {affNames.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                )}
                <button type="button" className="b2b-btn-secondary" onClick={toggleShown} disabled={busy || shownOk.length === 0}>{allShown ? "보이는 직원 모두 풀기" : "보이는 직원 모두 고르기"}</button>
              </div>
              <div className="b2b-table-wrap hr-bank-list">
                <table className="b2b-table hr-table">
                  <thead>
                    <tr><th className="hr-bank-check"></th><th>성명</th>{affNames.length > 0 && <th>소속</th>}<th>은행</th><th>계좌번호</th><th>예금주</th><th className="num">이체 금액</th><th>확인할 것</th></tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.employee_id} className={ok(r) ? "" : "hr-bank-off"}>
                        <td className="hr-bank-check"><input type="checkbox" checked={picked.has(r.employee_id)} disabled={busy || !ok(r)} aria-label={`${r.name} 고르기`} onChange={() => toggle(r.employee_id)} /></td>
                        <td><strong>{r.name}</strong></td>
                        {affNames.length > 0 && <td>{r.affiliation}</td>}
                        <td>{r.bank}</td>
                        <td className="hr-mono">{r.account}</td>
                        <td>{r.holder}</td>
                        <td className="num">{numText(r.amount)}</td>
                        <td>{r.problems.length > 0 ? <span className="hr-bad">{r.problems.join(" · ")}</span> : r.warns.join(" · ")}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && <tr><td colSpan={affNames.length > 0 ? 8 : 7} className="sm-faint">조건에 맞는 직원이 없습니다.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="hr-bank-labels">
                <label className="b2b-field">
                  <span className="b2b-field-label">받는분 통장표시</span>
                  <input className="b2b-input" value={labels.recv} maxLength={20} onChange={(e) => setLabels({ ...labels, recv: e.target.value })} />
                </label>
                <label className="b2b-field">
                  <span className="b2b-field-label">내 통장 메모</span>
                  <input className="b2b-input" value={labels.mine} maxLength={20} onChange={(e) => setLabels({ ...labels, mine: e.target.value })} />
                </label>
                <label className="b2b-field">
                  <span className="b2b-field-label">메모</span>
                  <input className="b2b-input" value={labels.memo} maxLength={20} onChange={(e) => setLabels({ ...labels, memo: e.target.value })} />
                </label>
              </div>
            </>
          )}
        </div>
        <div className="b2b-modal-foot">
          {data && <span className="hr-bank-sum">고른 직원 <strong>{chosen.length}</strong>명 · 합계 <strong>{numText(total)}</strong>원</span>}
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>닫기</button>
            <button type="button" className="b2b-btn-primary" onClick={download} disabled={busy || !data || chosen.length === 0}>{busy ? "만드는 중..." : "이체 파일 내려받기"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
