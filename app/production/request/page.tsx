"use client";

import { useCallback, useEffect, useState } from "react";

type Row = { name: string; spec: string; qty: number; manual: boolean };
type Data = { from: string; to: string; label: string; rows: Row[]; total: number };

const PERIODS = [1, 7, 14, 30] as const;

function todayIso() { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; }

export default function RequestPage() {
  const [days, setDays] = useState<number>(7);
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await (await fetch(`/api/production/request?days=${days}&date=${date}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 오류");
    }
    setLoading(false);
  }, [days, date]);
  useEffect(() => { load(); }, [load]);

  const downloadUrl = `/api/production/request?days=${days}&date=${date}&format=xlsx`;

  return (
    <div className="b2b-container" style={{ maxWidth: 900 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산요청서</h1>
          <p className="b2b-page-subtitle">제조사에 보낼 생산 요청을 일/주/월 단위로 추출합니다. (생산예정일 기준 집계)</p>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-primary" href={downloadUrl} style={{ textDecoration: "none" }}>엑셀 다운로드</a>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div className="sm-tabs">
            {PERIODS.map((n) => (
              <button key={n} className={`sm-tab ${days === n ? "is-active" : ""}`} onClick={() => setDays(n)}>{n}일</button>
            ))}
          </div>
          <input type="date" className="b2b-input" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} />
          {data && <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>{data.from} ~ {data.to}</span>}
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : !data || data.rows.length === 0 ? (
        <div className="b2b-empty">이 기간에 생산 예정인 품목이 없습니다. (생산예정일이 비어있으면 집계되지 않습니다)</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr><th>품목명</th><th>규격</th><th className="num">생산량</th><th>비고</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td>{r.spec || "-"}</td>
                  <td className="num"><strong>{r.qty.toLocaleString()}</strong></td>
                  <td>{r.manual ? <span className="prod-side-manual-tag">직접</span> : ""}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}><strong>합계</strong></td>
                <td className="num"><strong style={{ color: "var(--sm-orange)" }}>{data.total.toLocaleString()}</strong></td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
