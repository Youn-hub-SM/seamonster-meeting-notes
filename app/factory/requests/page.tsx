"use client";

// 파도소리 생산요청 — 씨몬스터가 보낸 생산요청(읽기 전용).
//  진행 상태는 씨몬스터 생산 관리에서 바뀐다.

import { useEffect, useState } from "react";
import { PR_STATUS_COLOR, PR_STATUS_LABEL, type PrStatus } from "@/app/lib/wholesale-production";

type PrRow = {
  id: string; req_no: string | null; title: string | null; request_date: string; due_date: string | null;
  status: PrStatus; total_requested: number; total_received: number;
  items: { name: string; sku: string | null; unit: string; requested_qty: number; received_qty: number }[];
};

export default function FactoryRequestsPage() {
  const [rows, setRows] = useState<PrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/factory/production-requests", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setRows(j.rows || []); else setError(j.error || "조회 실패"); })
      .catch(() => setError("조회 오류")).finally(() => setLoading(false));
  }, []);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">생산요청</h1></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : rows.length === 0 ? (
        <div className="b2b-empty">진행 중인 생산요청이 없습니다.</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr>
              <th>요청번호</th><th>요청일</th><th>마감일</th><th>품목</th><th className="num">요청</th><th className="num">입고</th><th>상태</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="요청번호">{r.req_no || "-"}</td>
                  <td data-label="요청일">{r.request_date}</td>
                  <td data-label="마감일">{r.due_date || "-"}</td>
                  <td data-label="품목">
                    {r.items.map((it, i) => (
                      <div key={i}><strong>{it.name}</strong> <span className="sm-faint">{it.requested_qty.toLocaleString()}{it.unit}</span></div>
                    ))}
                  </td>
                  <td data-label="요청" className="num b2b-money">{r.total_requested.toLocaleString()}</td>
                  <td data-label="입고" className="num b2b-money">{r.total_received.toLocaleString()}</td>
                  <td data-label="상태">
                    <span className="b2b-status-pill" style={{ background: PR_STATUS_COLOR[r.status].bg, color: PR_STATUS_COLOR[r.status].fg }}>
                      {PR_STATUS_LABEL[r.status]}
                    </span>
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
