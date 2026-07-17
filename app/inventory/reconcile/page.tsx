"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InvChannelFilter } from "@/app/lib/inventory";
import { ChannelFilter } from "../ChannelTabs";

type Row = {
  product_id: string; sku: string | null; name: string;
  current_qty: number; ledger_in: number; ledger_out: number; ledger_adj: number; sold: number;
};

const won = (n: number) => n.toLocaleString();
// KST 기준 날짜(back일 전) YYYY-MM-DD
const kstDay = (back = 0) => { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); };

export default function InventoryReconcilePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [salesMax, setSalesMax] = useState<string | null>(null); // 매출 입력 최신일(영업일에만 입력)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [channel, setChannel] = useState<InvChannelFilter>("소매"); // 도매는 B2B 발주에서 따로 관리 — 이 화면 기본은 소매만
  const [from, setFrom] = useState(kstDay(6));   // 기본: 최근 7일
  const [to, setTo] = useState(kstDay(0));
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
      if (!j.ok) throw new Error(j.error || "불러오기 실패");
      setRows(j.rows || []);
      setRange({ from: j.from, to: j.to });
      setSalesMax(j.salesMax || null);
    } catch (e) { setError(e instanceof Error ? e.message : "불러오기 오류"); }
    setLoading(false);
  }, [from, to, channel]);
  useEffect(() => { load(); }, [load]);

  // 판정
  const enriched = useMemo(() => rows.map((r) => {
    const notSubtracted = r.sold - r.ledger_out;          // 팔렸는데 재고에서 안 빠진 수
    const noBuy = r.sold > 0 && r.ledger_in === 0;        // 산 기록(구매) 없이 팔림
    const minusStock = r.current_qty < 0;                 // 재고가 마이너스(오류)
    const emptySelling = r.current_qty <= 0 && r.sold > 0;// 재고 0인데 계속 팔림
    const issue = noBuy || minusStock || emptySelling || Math.abs(notSubtracted) > 0;
    return { ...r, notSubtracted, noBuy, minusStock, emptySelling, issue };
  }), [rows]);

  const kpi = useMemo(() => {
    const sold = enriched.reduce((s, r) => s + r.sold, 0);
    const out = enriched.reduce((s, r) => s + r.ledger_out, 0);
    const adj = enriched.reduce((s, r) => s + r.ledger_adj, 0);
    const noBuy = enriched.filter((r) => r.noBuy);
    const minus = enriched.filter((r) => r.minusStock);
    return {
      sold, out, adj,
      coverage: sold > 0 ? Math.round((out / sold) * 1000) / 10 : (out > 0 ? 100 : 0),
      noBuyCount: noBuy.length, noBuySold: noBuy.reduce((s, r) => s + r.sold, 0),
      minusCount: minus.length,
    };
  }, [enriched]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    let arr = enriched.filter((r) => (!s || `${r.name} ${r.sku || ""}`.toLowerCase().includes(s)) && (!issuesOnly || r.issue));
    arr = [...arr].sort((a, b) =>
      sort === "gap" ? Math.abs(b.notSubtracted) - Math.abs(a.notSubtracted)
      : sort === "stock" ? a.current_qty - b.current_qty
      : b.sold - a.sold);
    return arr;
  }, [enriched, q, issuesOnly, sort]);

  const setPreset = (f: string, t: string) => { setFrom(f); setTo(t); };

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">구매·판매·재고 확인</h1>
          <p className="b2b-page-subtitle">세트 상품은 낱개(구성품)로 환산해 비교합니다</p>
        </div>
        <div className="b2b-page-actions"><ChannelFilter value={channel} onChange={setChannel} /></div>
      </header>

      {/* 기간 */}
      <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div className="sm-tabs" style={{ margin: 0 }}>
          <button className="sm-tab" onClick={() => setPreset(kstDay(0), kstDay(0))}>오늘</button>
          <button className="sm-tab" onClick={() => setPreset(kstDay(1), kstDay(1))}>어제</button>
          <button className="sm-tab" onClick={() => setPreset(kstDay(6), kstDay(0))}>최근 7일</button>
          <button className="sm-tab" onClick={() => setPreset(kstDay(29), kstDay(0))}>최근 30일</button>
        </div>
        <input type="date" className="b2b-input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} title="시작일" />
        <span style={{ color: "var(--sm-text-light)" }}>~</span>
        <input type="date" className="b2b-input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} title="끝일" />
        <span className="sm-faint" style={{ fontSize: 12 }}>보는 기간: {range.from} ~ {range.to}</span>
      </div>
      <p className="sm-faint" style={{ fontSize: 12, margin: "-4px 0 12px" }}>
        팔린 수 기준 — <strong>{channel === "도매" ? "도매(B2B 발송완료)" : channel === "소매" ? "소매(매출 데이터)" : "전체(소매 매출 + 도매 B2B 발송)"}</strong>. 채널을 바꾸면 그 채널 재고와 그 채널 판매로 비교합니다.
        {salesMax && <> · 매출 입력: <strong>~{salesMax}</strong></>}
      </p>
      {salesMax && to > salesMax && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "var(--sm-info-bg)", border: "1px solid var(--sm-info)", marginBottom: 12, fontSize: 12.5, lineHeight: 1.6 }}>
          매출은 <strong>{salesMax}</strong>까지 입력돼 있습니다(영업일에만 입력). 그 이후 주문일의 출고는 아직 비교할 매출이 없어
          <strong> 빠진 수만 먼저 보일 수 있어요</strong> — 다음 매출 입력 후에는 <strong>완전히 일치</strong>해야 정상입니다.
          (출고는 주문일 기준으로 기록되므로, 남는 차이 = 매핑 오류·CS 재발송 등 확인 대상)
        </div>
      )}

      {error && <div className="b2b-error">{error}{error.includes("051") ? " — supabase/migrations/051_inventory_reconcile.sql 를 먼저 적용하세요." : ""}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          {/* 안내 배너 */}
          {kpi.sold > 0 && kpi.coverage < 90 && (
            <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--sm-warning-bg)", border: "1px solid var(--sm-warning)", marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              이 기간에 실제로 <strong>{won(kpi.sold)}개</strong>가 팔렸는데, 재고에서 빠진 건 <strong>{won(kpi.out)}개({kpi.coverage}%)</strong>뿐이에요.
              판매가 재고에 <strong>거의 안 빠지고</strong> 있습니다. 매일 판매·구매·재고를 맞춰 주세요. (아래는 <strong>팔린 수를 실제 나간 수로 보고</strong> 비교한 표입니다.)
            </div>
          )}

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">팔린 수(판매)</div><div className="b2b-stat-card-value b2b-money">{won(kpi.sold)}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고에서 빠진 판매</div><div className="b2b-stat-card-value b2b-money" style={{ color: kpi.coverage < 90 ? "var(--sm-danger)" : "var(--sm-success)" }}>{won(kpi.out)} <span style={{ fontSize: 13 }}>({kpi.coverage}%)</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">산 기록 없이 팔린 품목</div><div className="b2b-stat-card-value" style={{ color: kpi.noBuyCount ? "var(--sm-danger)" : "var(--sm-black)" }}>{kpi.noBuyCount}개 <span className="sm-faint" style={{ fontSize: 12 }}>· 판매 {won(kpi.noBuySold)}</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 마이너스(오류)</div><div className="b2b-stat-card-value" style={{ color: kpi.minusCount ? "var(--sm-danger)" : "var(--sm-black)" }}>{kpi.minusCount}개</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">직접 맞춘 수(보정)</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-warning)" }}>{kpi.adj > 0 ? "+" : ""}{won(kpi.adj)}</div></div>
          </div>

          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span className="b2b-card-title">품목별로 보기 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· {shown.length}개</span></span>
              <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--sm-text-mid)" }}>
                  <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} /> 문제만 보기
                </label>
                <div className="sm-tabs" style={{ margin: 0 }}>
                  {([["sold", "많이 팔린 순"], ["gap", "안 빠진 순"], ["stock", "재고 적은 순"]] as const).map(([v, l]) => (
                    <button key={v} className={`sm-tab ${sort === v ? "is-active" : ""}`} onClick={() => setSort(v)}>{l}</button>
                  ))}
                </div>
                <input className="b2b-input" placeholder="품목·코드 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 150 }} />
              </div>
            </div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr>
                  <th>품목</th><th>코드</th>
                  <th className="num">남은 재고</th><th className="num">팔린 수</th>
                  <th className="num">산 수(구매)</th><th className="num">재고에서 뺀 수</th><th className="num">직접 맞춤</th>
                  <th className="num">안 빠진 판매</th><th>확인</th>
                </tr></thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr><td colSpan={9}><div className="b2b-empty" style={{ padding: "20px 10px" }}>볼 품목이 없습니다.</div></td></tr>
                  ) : shown.map((r) => (
                    <tr key={r.product_id}>
                      <td><strong>{r.name}</strong></td>
                      <td className="sm-faint" style={{ fontSize: 11 }}>{r.sku || "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700, color: r.current_qty < 0 ? "var(--sm-danger)" : undefined }}>{won(r.current_qty)}</td>
                      <td className="num b2b-money">{r.sold ? won(r.sold) : "-"}</td>
                      <td className="num b2b-money" style={{ color: r.ledger_in ? "var(--sm-success)" : "var(--sm-text-light)" }}>{r.ledger_in ? won(r.ledger_in) : "-"}</td>
                      <td className="num b2b-money" style={{ color: r.ledger_out ? "var(--sm-info)" : "var(--sm-text-light)" }}>{r.ledger_out ? won(r.ledger_out) : "-"}</td>
                      <td className="num b2b-money" style={{ color: r.ledger_adj ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{r.ledger_adj ? (r.ledger_adj > 0 ? "+" : "") + won(r.ledger_adj) : "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700, color: r.notSubtracted > 0 ? "var(--sm-warning)" : r.notSubtracted < 0 ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{r.notSubtracted ? (r.notSubtracted > 0 ? "+" : "") + won(r.notSubtracted) : "0"}</td>
                      <td>
                        <span className="sm-row" style={{ gap: 4, flexWrap: "wrap" }}>
                          {r.noBuy && <span className="b2b-status-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }}>산 기록 없음</span>}
                          {r.minusStock && <span className="b2b-status-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }}>재고 마이너스</span>}
                          {!r.minusStock && r.emptySelling && <span className="b2b-status-pill" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)" }}>재고 0인데 팔림</span>}
                          {!r.issue && <span className="sm-faint" style={{ fontSize: 11 }}>이상 없음</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
              · <strong>팔린 수</strong>=매출 데이터에서 실제 팔린 개수(세트는 낱개로 풀어서). · <strong>산 수(구매)·재고에서 뺀 수·직접 맞춤</strong>=이 기간에 재고에 기록된 들어옴/나감/보정.
              <br />· <strong>안 빠진 판매</strong>=팔렸는데 재고에서 아직 안 뺀 수(+면 재고에 반영이 덜 된 것). · <strong>산 기록 없음</strong>=팔렸는데 구매(들어온) 기록이 하나도 없음 → 구매를 넣어 주세요. · <strong>재고 마이너스</strong>=있을 수 없는 재고라 점검이 필요해요.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
