"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InvChannelFilter } from "@/app/lib/inventory";
import { ChannelFilter } from "../ChannelTabs";

type Row = {
  product_id: string; sku: string | null; name: string;
  current_qty: number; ledger_in: number; ledger_out: number; ledger_adj: number; sold: number;
};

const won = (n: number) => n.toLocaleString();
const PRESETS: { label: string; days: number }[] = [
  { label: "7일", days: 7 }, { label: "30일", days: 30 }, { label: "90일", days: 90 },
];

export default function InventoryReconcilePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [channel, setChannel] = useState<InvChannelFilter>("전체");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [sort, setSort] = useState<"sold" | "gap" | "stock">("sold");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams();
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (channel !== "전체") p.set("channel", channel);
      const j = await (await fetch(`/api/inventory/reconcile?${p.toString()}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
      setRange({ from: j.from, to: j.to });
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [from, to, channel]);
  useEffect(() => { load(); }, [load]);

  function applyPreset(days: number) {
    const t = new Date();
    const f = new Date(); f.setDate(f.getDate() - days);
    setTo(t.toISOString().slice(0, 10));
    setFrom(f.toISOString().slice(0, 10));
  }

  // 정합성 판정
  const enriched = useMemo(() => rows.map((r) => {
    const gapOut = r.sold - r.ledger_out;                 // >0 : 판매가 원장 출고에 미반영
    const noPurchase = r.sold > 0 && r.ledger_in === 0;   // 매입/생산 기록 없이 판매됨
    const negStock = r.current_qty < 0;                   // 불가능한 재고(데이터 오류)
    const zeroSelling = r.current_qty <= 0 && r.sold > 0; // 재고 0인데 계속 판매
    const issue = noPurchase || negStock || zeroSelling || Math.abs(gapOut) > 0;
    return { ...r, gapOut, noPurchase, negStock, zeroSelling, issue };
  }), [rows]);

  const kpi = useMemo(() => {
    const sold = enriched.reduce((s, r) => s + r.sold, 0);
    const out = enriched.reduce((s, r) => s + r.ledger_out, 0);
    const adj = enriched.reduce((s, r) => s + r.ledger_adj, 0);
    const noPur = enriched.filter((r) => r.noPurchase);
    const neg = enriched.filter((r) => r.negStock);
    return {
      sold, out, adj,
      coverage: sold > 0 ? Math.round((out / sold) * 1000) / 10 : (out > 0 ? 100 : 0),
      noPurCount: noPur.length, noPurSold: noPur.reduce((s, r) => s + r.sold, 0),
      negCount: neg.length,
    };
  }, [enriched]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    let arr = enriched.filter((r) => (!s || `${r.name} ${r.sku || ""}`.toLowerCase().includes(s)) && (!issuesOnly || r.issue));
    arr = [...arr].sort((a, b) =>
      sort === "gap" ? Math.abs(b.gapOut) - Math.abs(a.gapOut)
      : sort === "stock" ? a.current_qty - b.current_qty
      : b.sold - a.sold);
    return arr;
  }, [enriched, q, issuesOnly, sort]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 정합성 대사</h1>
          <p className="b2b-page-subtitle">
            실제 판매(매출 데이터)를 <strong>진짜 출고</strong>로 보고 재고 원장과 대조합니다. 번들은 구성품으로 전개.
            <strong> 출고가 제대로 잡혔는지 · 매입이 정확한지</strong>를 SKU별로 점검하세요.
          </p>
        </div>
        <div className="b2b-page-actions"><ChannelFilter value={channel} onChange={setChannel} /></div>
      </header>

      {/* 기간 */}
      <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div className="sm-tabs" style={{ margin: 0 }}>
          {PRESETS.map((p) => <button key={p.days} className="sm-tab" onClick={() => applyPreset(p.days)}>최근 {p.label}</button>)}
        </div>
        <input type="date" className="b2b-input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} title="시작일" />
        <span style={{ color: "var(--sm-text-light)" }}>~</span>
        <input type="date" className="b2b-input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} title="종료일" />
        <span className="sm-faint" style={{ fontSize: 12 }}>기준 기간: {range.from} ~ {range.to}</span>
      </div>

      {error && <div className="b2b-error">{error}{error.includes("051") ? " — supabase/migrations/051_inventory_reconcile.sql 를 먼저 적용하세요." : ""}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          {/* 출고 반영률 경고 배너 */}
          {kpi.sold > 0 && kpi.coverage < 90 && (
            <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--sm-warning-bg)", border: "1px solid var(--sm-warning)", marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              ⚠️ 기간 내 실제 판매 <strong>{won(kpi.sold)}개</strong> 중 재고 원장 출고는 <strong>{won(kpi.out)}개(반영률 {kpi.coverage}%)</strong>.
              판매가 재고에 <strong>거의 반영되지 않고</strong> 있습니다. 아래는 매출을 실제 출고로 간주한 대사이며, 재고를 실제와 맞추려면 판매분을 출고로 반영하거나 정기 실사(조정)가 필요합니다.
            </div>
          )}

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">실제 판매(기간)</div><div className="b2b-stat-card-value b2b-money">{won(kpi.sold)}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">원장 출고 · 반영률</div><div className="b2b-stat-card-value b2b-money" style={{ color: kpi.coverage < 90 ? "var(--sm-danger)" : "var(--sm-success)" }}>{won(kpi.out)} <span style={{ fontSize: 13 }}>({kpi.coverage}%)</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">매입 미기록 SKU</div><div className="b2b-stat-card-value" style={{ color: kpi.noPurCount ? "var(--sm-danger)" : "var(--sm-black)" }}>{kpi.noPurCount}건 <span className="sm-faint" style={{ fontSize: 12 }}>· 판매 {won(kpi.noPurSold)}</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">현재고 음수</div><div className="b2b-stat-card-value" style={{ color: kpi.negCount ? "var(--sm-danger)" : "var(--sm-black)" }}>{kpi.negCount}건</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">기간 조정 합</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-warning)" }}>{kpi.adj > 0 ? "+" : ""}{won(kpi.adj)}</div></div>
          </div>

          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span className="b2b-card-title">SKU별 대사 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· {shown.length}건</span></span>
              <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--sm-text-mid)" }}>
                  <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} /> 이슈만
                </label>
                <div className="sm-tabs" style={{ margin: 0 }}>
                  {([["sold", "판매순"], ["gap", "미반영순"], ["stock", "재고낮은순"]] as const).map(([v, l]) => (
                    <button key={v} className={`sm-tab ${sort === v ? "is-active" : ""}`} onClick={() => setSort(v)}>{l}</button>
                  ))}
                </div>
                <input className="b2b-input" placeholder="품목·SKU 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 150 }} />
              </div>
            </div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr>
                  <th>품목</th><th>SKU</th>
                  <th className="num">현재고</th><th className="num">실판매</th>
                  <th className="num">원장입고</th><th className="num">원장출고</th><th className="num">조정</th>
                  <th className="num">출고 미반영</th><th>상태</th>
                </tr></thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr><td colSpan={9} className="sm-faint" style={{ padding: "16px 4px" }}>대사할 품목이 없습니다.</td></tr>
                  ) : shown.map((r) => (
                    <tr key={r.product_id}>
                      <td><strong>{r.name}</strong></td>
                      <td className="sm-faint" style={{ fontSize: 11 }}>{r.sku || "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700, color: r.current_qty < 0 ? "var(--sm-danger)" : undefined }}>{won(r.current_qty)}</td>
                      <td className="num b2b-money">{r.sold ? won(r.sold) : "-"}</td>
                      <td className="num b2b-money" style={{ color: r.ledger_in ? "var(--sm-success)" : "var(--sm-text-light)" }}>{r.ledger_in ? won(r.ledger_in) : "-"}</td>
                      <td className="num b2b-money" style={{ color: r.ledger_out ? "var(--sm-info)" : "var(--sm-text-light)" }}>{r.ledger_out ? won(r.ledger_out) : "-"}</td>
                      <td className="num b2b-money" style={{ color: r.ledger_adj ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{r.ledger_adj ? (r.ledger_adj > 0 ? "+" : "") + won(r.ledger_adj) : "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700, color: r.gapOut > 0 ? "var(--sm-warning)" : r.gapOut < 0 ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{r.gapOut ? (r.gapOut > 0 ? "+" : "") + won(r.gapOut) : "0"}</td>
                      <td>
                        <span className="sm-row" style={{ gap: 4, flexWrap: "wrap" }}>
                          {r.noPurchase && <span className="b2b-feed-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)", fontSize: 10.5, fontWeight: 700 }}>매입 미기록</span>}
                          {r.negStock && <span className="b2b-feed-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)", fontSize: 10.5, fontWeight: 700 }}>재고 음수</span>}
                          {!r.negStock && r.zeroSelling && <span className="b2b-feed-pill" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)", fontSize: 10.5, fontWeight: 700 }}>재고 0·판매중</span>}
                          {!r.issue && <span className="sm-faint" style={{ fontSize: 11 }}>정상</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
              ※ <strong>실판매</strong>=매출 데이터 판매수량(번들 구성품 전개). <strong>원장입고/출고/조정</strong>=선택 기간 재고 원장 흐름. <strong>출고 미반영</strong>=실판매−원장출고(+면 재고에 안 빠진 판매). <strong>현재고</strong>는 채널 기준 현재 시점.
              <br />· <strong>매입 미기록</strong>: 팔렸는데 입고 기록이 전혀 없음 → 매입/생산 기록 필요. · <strong>재고 음수</strong>: 원장상 불가능한 재고 → 데이터 점검.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
