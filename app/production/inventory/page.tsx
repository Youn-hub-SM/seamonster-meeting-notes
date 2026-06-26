"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type InvRow = {
  sku: string;
  name: string;
  stock: number | null;
  dailyOut: number;
  safety: number;
  demand: number;
  recommend: number;
  belowSafety: boolean;
  inBoxhero: boolean;
  inB2B: boolean;
};

export default function InventoryPage() {
  const [rows, setRows] = useState<InvRow[]>([]);
  const [configured, setConfigured] = useState(true);
  const [itemCount, setItemCount] = useState(0);
  const [noSkuDemand, setNoSkuDemand] = useState(0);
  const [leadDays, setLeadDays] = useState(10);
  const [spanDays, setSpanDays] = useState(0);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [onlyNeed, setOnlyNeed] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/production/inventory", { cache: "no-store" });
      const j = await res.json();
      if (j.configured === false) { setConfigured(false); setRows([]); setLoading(false); return; }
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setConfigured(true);
      setRows(j.rows || []);
      setItemCount(j.itemCount || 0);
      setNoSkuDemand(j.noSkuDemand || 0);
      setLeadDays(j.leadDays || 10);
      setSpanDays(j.velocitySpanDays || 0);
      setCapped(!!j.velocityCapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    let needItems = 0, needQty = 0, below = 0;
    for (const r of rows) {
      if (r.recommend > 0) { needItems++; needQty += r.recommend; }
      if (r.belowSafety) below++;
    }
    return { needItems, needQty, below };
  }, [rows]);

  const shown = useMemo(() => (onlyNeed ? rows.filter((r) => r.recommend > 0) : rows), [rows, onlyNeed]);

  if (!configured && !loading) {
    return (
      <div className="b2b-container" style={{ maxWidth: 760 }}>
        <header className="b2b-page-head">
          <div>
            <h1 className="b2b-page-title">재고·생산필요</h1>
            <p className="b2b-page-subtitle">박스히어로 현재고와 B2B 수요를 합쳐 권장 생산량을 계산합니다.</p>
          </div>
        </header>
        <section className="b2b-card">
          <div className="b2b-empty" style={{ padding: "40px 20px" }}>
            <div className="b2b-empty-icon">🔌</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>박스히어로 연동이 필요합니다</div>
            <div style={{ color: "var(--sm-text-mid)", marginBottom: 16 }}>
              설정에서 박스히어로 API 토큰을 등록하면 현재고·안전재고가 연동됩니다.
            </div>
            <Link href="/production/settings" className="b2b-btn-primary">설정으로 이동</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고·생산필요</h1>
          <p className="b2b-page-subtitle">
            권장 생산량 = B2B 수요 + 안전재고 − 현재고. 안전재고 = 최근 하루 출고 × {leadDays}일(생산 리드타임). 박스히어로 {itemCount}개 품목 기준.
          </p>
        </div>
        <div className="b2b-page-actions">
          <label className="prod-filter-check">
            <input type="checkbox" checked={onlyNeed} onChange={(e) => setOnlyNeed(e.target.checked)} />
            생산필요만
          </label>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">생산 권장 품목</div>
          <div className="b2b-stat-card-value">{stats.needItems}종</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">총 권장 생산량</div>
          <div className="b2b-stat-card-value">{stats.needQty.toLocaleString()}</div>
        </div>
        <div className="b2b-stat-card" style={stats.below > 0 ? { borderColor: "#f5c6c6" } : undefined}>
          <div className="b2b-stat-card-label" style={stats.below > 0 ? { color: "#c92a2a" } : undefined}>
            안전재고 미달
          </div>
          <div className="b2b-stat-card-value" style={stats.below > 0 ? { color: "#c92a2a" } : undefined}>
            {stats.below}종
          </div>
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty">
          <div className="b2b-empty-icon">✅</div>
          {onlyNeed ? "지금 추가로 생산할 품목이 없습니다." : "표시할 품목이 없습니다."}
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>품목</th>
                <th className="num">현재고</th>
                <th className="num">하루 출고</th>
                <th className="num">안전재고</th>
                <th className="num">B2B 수요</th>
                <th className="num">권장 생산</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku} className={r.belowSafety ? "is-overdue" : ""}>
                  <td><code style={{ fontSize: 12.5 }}>{r.sku}</code></td>
                  <td>
                    {r.name}
                    {!r.inBoxhero && <span className="prod-tag">박스히어로 없음</span>}
                  </td>
                  <td className="num">
                    {r.stock == null ? <span style={{ color: "var(--sm-text-light)" }}>-</span> : (
                      <span style={r.belowSafety ? { color: "#c92a2a", fontWeight: 700 } : undefined}>
                        {r.stock.toLocaleString()}
                      </span>
                    )}
                  </td>
                  <td className="num">{r.dailyOut ? r.dailyOut.toFixed(1) : <span style={{ color: "var(--sm-text-light)" }}>-</span>}</td>
                  <td className="num">{r.safety ? r.safety.toLocaleString() : <span style={{ color: "var(--sm-text-light)" }}>-</span>}</td>
                  <td className="num">{r.demand ? r.demand.toLocaleString() : "-"}</td>
                  <td className="num">
                    {r.recommend > 0 ? <strong style={{ color: "var(--sm-orange)" }}>{r.recommend.toLocaleString()}</strong> : <span style={{ color: "var(--sm-text-light)" }}>0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {spanDays > 0 && (
        <p className="prod-note">※ 안전재고는 박스히어로 출고 내역 기준, 최근 약 {spanDays}일 평균 출고 × {leadDays}일(생산 리드타임)로 자동 계산됩니다{capped ? " (출고 표본 일부만 집계)" : ""}. 박스히어로에 적힌 안전재고 값은 쓰지 않습니다.</p>
      )}
      {noSkuDemand > 0 && (
        <p className="prod-note">※ SKU가 연결되지 않은 B2B 수요 {noSkuDemand.toLocaleString()}개는 재고 매칭에서 제외됐습니다(품목에 SKU를 지정하면 포함됩니다).</p>
      )}
    </div>
  );
}
