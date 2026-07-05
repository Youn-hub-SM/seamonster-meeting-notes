"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow, InventoryTxn, InvChannelFilter } from "@/app/lib/inventory";
import { TrendChart, BarList } from "@/app/components/charts";
import { ChannelFilter } from "../ChannelTabs";

export default function InvStatsPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [txns, setTxns] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [groupBy, setGroupBy] = useState<"품목" | "SKU">("품목");
  const [channel, setChannel] = useState<InvChannelFilter>("전체");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const cq = channel === "전체" ? "" : `&channel=${encodeURIComponent(channel)}`;
      const [ij, tj] = await Promise.all([
        (await fetch(`/api/inventory${channel === "전체" ? "" : `?channel=${encodeURIComponent(channel)}`}`, { cache: "no-store" })).json(),
        (await fetch(`/api/inventory/txns?limit=2000${cq}`, { cache: "no-store" })).json(),
      ]);
      if (!ij.ok) throw new Error(ij.error || "조회 실패");
      setRows(ij.rows || []);
      if (tj.ok) setTxns(tj.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [channel]);
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

  const topValue = useMemo<[string, number][]>(() => rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10).map((r) => [r.spec ? `${r.name} · ${r.spec}` : r.name, r.value]), [rows]);

  // 품목별 입고/출고/조정 합(원장 기준)
  const txnByProduct = useMemo(() => {
    const m = new Map<string, { inq: number; outq: number; adj: number }>();
    for (const t of txns) {
      const cur = m.get(t.product_id) || { inq: 0, outq: 0, adj: 0 };
      if (t.type === "입고") cur.inq += t.qty;
      else if (t.type === "출고") cur.outq += Math.abs(t.qty);
      else cur.adj += t.qty;
      m.set(t.product_id, cur);
    }
    return m;
  }, [txns]);

  // 품목(옵션 구분) 또는 SKU 별 집계
  const agg = useMemo(() => {
    const items = rows.map((r) => ({ r, s: txnByProduct.get(r.product_id) || { inq: 0, outq: 0, adj: 0 } }));
    if (groupBy === "품목") {
      return items.map(({ r, s }) => ({ key: r.product_id, label: r.name, sub: r.spec || r.sku || "", qty: r.qty, value: r.value, inq: s.inq, outq: s.outq, adj: s.adj }));
    }
    const m = new Map<string, { qty: number; value: number; inq: number; outq: number; adj: number; names: Set<string> }>();
    for (const { r, s } of items) {
      const k = r.sku || "(SKU 없음)";
      const cur = m.get(k) || { qty: 0, value: 0, inq: 0, outq: 0, adj: 0, names: new Set<string>() };
      cur.qty += r.qty; cur.value += r.value; cur.inq += s.inq; cur.outq += s.outq; cur.adj += s.adj; cur.names.add(r.name);
      m.set(k, cur);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, label: k, sub: [...v.names].join(", "), qty: v.qty, value: v.value, inq: v.inq, outq: v.outq, adj: v.adj }));
  }, [rows, txnByProduct, groupBy]);

  const shownAgg = useMemo(() => {
    const s = q.trim().toLowerCase();
    return agg.filter((a) => !s || `${a.label} ${a.sub}`.toLowerCase().includes(s)).sort((a, b) => b.value - a.value || b.qty - a.qty);
  }, [agg, q]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고/생산 통계</h1><p className="b2b-page-subtitle">재고자산·월별 입출고 추세와 <strong>품목(옵션 구분)·SKU별 집계</strong>를 봅니다. <strong>도매/소매</strong> 채널로 걸러 볼 수 있어요. 산 수·팔린 수·재고가 맞는지 보려면 <a href="/inventory/reconcile">구매·판매·재고 확인</a>.</p></div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href="/inventory/reconcile" title="팔린 수(매출)와 산 수, 지금 재고가 맞는지 확인">구매·판매·재고 확인</a>
          <ChannelFilter value={channel} onChange={setChannel} />
        </div>
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

          {/* 품목(옵션 구분)·SKU별 집계 */}
          <section className="b2b-card" style={{ marginTop: 16 }}>
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span className="b2b-card-title">{groupBy === "품목" ? "품목별" : "SKU별"} 집계 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· {shownAgg.length}건</span></span>
              <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <div className="sm-tabs" style={{ margin: 0 }}>
                  {(["품목", "SKU"] as const).map((g) => (
                    <button key={g} className={`sm-tab ${groupBy === g ? "is-active" : ""}`} onClick={() => setGroupBy(g)}>{g === "품목" ? "품목별(옵션 구분)" : "SKU별"}</button>
                  ))}
                </div>
                <input className="b2b-input" placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 160 }} />
              </div>
            </div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>{groupBy === "품목" ? "품목" : "SKU"}</th><th>{groupBy === "품목" ? "옵션/SKU" : "품목"}</th><th className="num">현재고</th><th className="num">입고</th><th className="num">출고</th><th className="num">조정</th><th className="num">재고자산(원)</th></tr></thead>
                <tbody>
                  {shownAgg.length === 0 ? (
                    <tr><td colSpan={7} className="sm-faint" style={{ padding: "16px 4px" }}>집계할 품목이 없습니다.</td></tr>
                  ) : shownAgg.map((a) => (
                    <tr key={a.key}>
                      <td><strong>{a.label}</strong></td>
                      <td className="sm-faint" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.sub || "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{a.qty.toLocaleString()}</td>
                      <td className="num b2b-money" style={{ color: a.inq ? "var(--sm-success)" : "var(--sm-text-light)" }}>{a.inq ? a.inq.toLocaleString() : "-"}</td>
                      <td className="num b2b-money" style={{ color: a.outq ? "var(--sm-info)" : "var(--sm-text-light)" }}>{a.outq ? a.outq.toLocaleString() : "-"}</td>
                      <td className="num b2b-money" style={{ color: a.adj ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{a.adj ? (a.adj > 0 ? "+" : "") + a.adj.toLocaleString() : "-"}</td>
                      <td className="num b2b-money">{a.value.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>※ 입고·출고·조정은 불러온 원장(최근 2000건) 합계. 현재고·재고자산은 전체 기준.</p>
          </section>
        </>
      )}
    </div>
  );
}
