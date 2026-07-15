"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow, InvChannelFilter } from "@/app/lib/inventory";
import { ChannelFilter } from "../ChannelTabs";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export default function AsOfPage() {
  const [date, setDate] = useState(TODAY());
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<InvChannelFilter>("전체");
  const [hideZero, setHideZero] = useState(true);

  const load = useCallback(async (d: string) => {
    setLoading(true); setError("");
    try {
      const cq = channel === "전체" ? "" : `&channel=${encodeURIComponent(channel)}`;
      const j = await (await fetch(`/api/inventory?asof=${d}${cq}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [channel]);
  useEffect(() => { load(date); }, [load, date]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (hideZero && r.qty === 0) return false;
      if (q && !(`${r.name} ${r.sku || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, search, hideZero]);
  const totalValue = useMemo(() => shown.reduce((s, r) => s + r.value, 0), [shown]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">과거 수량 조회</h1><p className="b2b-page-subtitle">선택한 날짜 <strong>마감 시점</strong>의 누적 재고입니다(그날까지의 입출고·조정 합).</p></div>
      </header>
      {error && <div className="b2b-error">{error}</div>}

      <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <span className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="sm-faint" style={{ fontSize: 13 }}>기준일</span>
          <input className="b2b-input" type="date" value={date} max={TODAY()} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} />
          <ChannelFilter value={channel} onChange={setChannel} style={{ marginLeft: 4 }} />
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)", marginLeft: 8 }}><input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} /> 0 숨기기</label>
        </span>
        <input className="b2b-input" placeholder="품목·SKU 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220, maxWidth: "100%" }} />
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <>
          <p className="sm-faint" style={{ fontSize: 13, marginBottom: 8 }}>{date} 마감 기준 · {shown.length}개 품목 · 재고자산 <strong className="b2b-money">{totalValue.toLocaleString()}원</strong></p>
          {shown.length === 0 ? (
            <div className="b2b-empty">{rows.length === 0 ? "해당 날짜 기준 재고 기록이 없습니다." : "조건에 맞는 품목이 없습니다."}</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>품목</th><th>SKU</th><th className="num">수량</th><th className="num">재고자산</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.product_id}>
                      <td><strong>{r.name}</strong>{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}</td>
                      <td className="sm-faint">{r.sku || "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{r.qty.toLocaleString()}{r.unit}</td>
                      <td className="num b2b-money">{r.value.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
