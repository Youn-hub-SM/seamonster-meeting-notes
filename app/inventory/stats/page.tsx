"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow, InventoryTxn } from "@/app/lib/inventory";
import { TrendChart, BarList } from "@/app/components/charts";

export default function InvStatsPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [txns, setTxns] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [ij, tj] = await Promise.all([
        (await fetch("/api/inventory", { cache: "no-store" })).json(),
        (await fetch("/api/inventory/txns?limit=2000", { cache: "no-store" })).json(),
      ]);
      if (!ij.ok) throw new Error(ij.error || "조회 실패");
      setRows(ij.rows || []);
      if (tj.ok) setTxns(tj.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => ({
    value: rows.reduce((s, r) => s + r.value, 0),
    items: rows.length,
    low: rows.filter((r) => r.low).length,
    qty: rows.reduce((s, r) => s + r.qty, 0),
  }), [rows]);

  // 월별 입고/출고 수량
  const monthly = useMemo(() => {
    const m = new Map<string, { inq: number; outq: number }>();
    for (const t of txns) {
      const k = (t.txn_date || "").slice(0, 7);
      if (!k) continue;
      const cur = m.get(k) || { inq: 0, outq: 0 };
      if (t.type === "입고") cur.inq += t.qty;
      else if (t.type === "출고") cur.outq += Math.abs(t.qty);
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [txns]);
  const inTrend = useMemo(() => monthly.map(([k, v]) => ({ label: k.slice(2), value: v.inq, tip: `${k} 입고 ${v.inq.toLocaleString()}` })), [monthly]);
  const outTrend = useMemo(() => monthly.map(([k, v]) => ({ label: k.slice(2), value: v.outq, tip: `${k} 출고 ${v.outq.toLocaleString()}` })), [monthly]);

  const topValue = useMemo<[string, number][]>(() => rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10).map((r) => [r.name, r.value]), [rows]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고 통계</h1><p className="b2b-page-subtitle">재고자산·월별 입출고·자산 비중을 집계합니다.</p></div>
      </header>
      {error && <div className="b2b-error">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 16 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 자산(원가)</div><div className="b2b-stat-card-value b2b-money">{totals.value.toLocaleString()}원</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 수량</div><div className="b2b-stat-card-value b2b-money">{totals.qty.toLocaleString()}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 부족</div><div className="b2b-stat-card-value" style={{ color: totals.low ? "var(--sm-danger)" : "var(--sm-black)" }}>{totals.low}건</div></div>
          </div>

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginBottom: 16 }}>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">월별 입고 수량</span></div>
              <TrendChart data={inTrend} />
            </section>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">월별 출고 수량</span></div>
              <TrendChart data={outTrend} />
            </section>
          </div>

          <BarList title="재고자산 TOP(원)" data={topValue} fmt={(n) => n.toLocaleString()} />
        </>
      )}
    </div>
  );
}
