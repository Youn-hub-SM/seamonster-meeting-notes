"use client";

// 파도소리 히스토리 — 기간별 입출고 내역. 이동 취소는 보낸 쪽·받은 쪽이 함께 취소된다.

import { useCallback, useEffect, useState } from "react";
import { TXN_TYPE_COLOR, type LotTxnWithLot } from "@/app/lib/factory";
import { today, daysAgo, n0 } from "../util";

export default function FactoryHistoryPage() {
  const [txns, setTxns] = useState<LotTxnWithLot[]>([]);
  const [from, setFrom] = useState(daysAgo(14));
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/factory/txns?from=${from}&to=${to}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setTxns(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">히스토리</h1></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="sm-row sm-gap-2" style={{ margin: "8px 0", alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" className="b2b-input" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="sm-faint">~</span>
        <input type="date" className="b2b-input" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="b2b-btn-secondary" onClick={load}>조회</button>
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : txns.length === 0 ? (
        <div className="b2b-empty">해당 기간 거래가 없습니다.</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr>
              <th>날짜</th><th>유형</th><th>품명</th><th>규격</th><th>창고</th>
              <th className="num">수량</th><th>행선지</th><th>메모</th><th></th>
            </tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id}>
                  <td data-label="날짜" style={{ whiteSpace: "nowrap" }}>{(t.txn_date || "").slice(0, 10)}</td>
                  <td data-label="유형">
                    <span className="b2b-status-pill" style={{ background: TXN_TYPE_COLOR[t.type].bg, color: TXN_TYPE_COLOR[t.type].fg }}>{t.type}</span>
                  </td>
                  <td data-label="품명"><strong>{t.item_name}</strong>{t.tape_color ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{t.tape_color}</span> : null}</td>
                  <td data-label="규격" className="sm-faint">{t.spec || "-"}</td>
                  <td data-label="창고">{t.warehouse}</td>
                  <td data-label="수량" className="num b2b-money" style={{ fontWeight: 700, color: n0(t.qty) < 0 ? "var(--sm-info)" : "var(--sm-success)" }}>
                    {n0(t.qty) > 0 ? "+" : ""}{n0(t.qty).toLocaleString()}
                  </td>
                  <td data-label="행선지">{t.dest || "-"}</td>
                  <td data-label="메모" className="sm-faint">{t.memo || "-"}</td>
                  <td>
                    <button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }}
                      onClick={async () => {
                        if (!confirm(t.move_id ? "이동은 보낸 쪽·받은 쪽이 함께 취소됩니다. 계속할까요?" : "이 거래를 취소할까요?")) return;
                        const j = await (await fetch(`/api/factory/txns/${t.id}`, { method: "DELETE" })).json();
                        if (!j.ok) setError(j.error || "취소 실패"); else load();
                      }}>취소</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
