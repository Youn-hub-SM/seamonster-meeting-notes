"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/app/lib/b2b-orders";

type Report = {
  period: { from: string; to: string };
  summary: {
    revenue: number;
    revenue_taxable: number;
    revenue_exempt: number;
    vat: number;
    orders_completed: number;
    avg_order_value: number;
    margin: number;
  };
  backlog: {
    pending_orders: number;
    pending_total: number;
  };
  by_company: { company_name: string; orders: number; revenue: number; margin: number }[];
  by_product: { product_name: string; spec: string | null; qty: number; revenue: number; cost: number; margin: number }[];
  trend: { month: string; revenue: number }[];
};

type Preset = "this_month" | "last_month" | "this_year" | "custom";

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (preset === "this_month") {
    return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  }
  if (preset === "last_month") {
    return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  }
  if (preset === "this_year") {
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  return { from: iso(new Date(y, m, 1)), to: iso(now) };
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ReportsPage() {
  const [preset, setPreset] = useState<Preset>("this_month");
  const initial = presetRange("this_month");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  }

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/b2b/reports?from=${from}&to=${to}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "조회 실패");
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  async function handleExport() {
    setExporting(true);
    setError("");
    try {
      const res = await fetch(`/api/b2b/reports/export?from=${from}&to=${to}`, { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text();
        try {
          const j = JSON.parse(text);
          throw new Error(j.error || "다운로드 실패");
        } catch {
          throw new Error("다운로드 실패 (HTTP " + res.status + ")");
        }
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/);
      a.download = m ? m[1] : `sales_${from}_${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "다운로드 중 오류");
    }
    setExporting(false);
  }

  const trendMax = useMemo(() => {
    if (!report) return 0;
    return Math.max(0, ...report.trend.map((t) => t.revenue));
  }, [report]);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 집계</h1>
          <p className="b2b-page-subtitle">
            발주일 기준 · 취소를 제외한 발주를 발주일이 속한 기간으로 집계합니다.
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <button
            className="b2b-btn-primary"
            onClick={handleExport}
            disabled={exporting || loading || !report || report.summary.orders_completed === 0}
            title={report && report.summary.orders_completed === 0 ? "이 기간에 등록된 발주가 없습니다" : ""}
          >
            {exporting ? "생성 중..." : "엑셀 다운로드"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {(["this_month", "last_month", "this_year", "custom"] as Preset[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`b2b-preset-btn ${preset === p ? "is-active" : ""}`}
                onClick={() => applyPreset(p)}
              >
                {presetLabel(p)}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
            <input
              type="date"
              className="b2b-input"
              value={from}
              onChange={(e) => { setFrom(e.target.value); setPreset("custom"); }}
              style={{ width: "auto" }}
            />
            <span style={{ color: "var(--sm-text-light)" }}>~</span>
            <input
              type="date"
              className="b2b-input"
              value={to}
              onChange={(e) => { setTo(e.target.value); setPreset("custom"); }}
              style={{ width: "auto" }}
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : !report ? (
        <div className="b2b-empty">데이터 없음</div>
      ) : (
        <>
          {/* KPI 카드들 */}
          <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">총 매출</div>
              <div className="b2b-stat-card-value b2b-money">{formatMoney(report.summary.revenue)}</div>
              <div className="b2b-stat-card-hint">
                과세 {formatMoney(report.summary.revenue_taxable)} · 면세 {formatMoney(report.summary.revenue_exempt)}
              </div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">발주 건수</div>
              <div className="b2b-stat-card-value b2b-money">{report.summary.orders_completed}</div>
              <div className="b2b-stat-card-hint">
                건당 평균 {formatMoney(report.summary.avg_order_value)}원
              </div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">예상 마진</div>
              <div className="b2b-stat-card-value b2b-money">{formatMoney(report.summary.margin)}</div>
              <div className="b2b-stat-card-hint">
                매출 대비 {report.summary.revenue > 0 ? Math.round((report.summary.margin / report.summary.revenue) * 100) : 0}%
              </div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">미발송 잔고 (전체 기간)</div>
              <div className="b2b-stat-card-value b2b-money">{formatMoney(report.backlog.pending_total)}</div>
              <div className="b2b-stat-card-hint">{report.backlog.pending_orders}건 진행 중</div>
            </div>
          </div>

          {/* 월별 추세 */}
          {report.trend.length > 0 && (
            <div className="b2b-card" style={{ marginBottom: 16 }}>
              <div className="b2b-card-head">
                <h2 className="b2b-card-title">월별 매출 추세</h2>
              </div>
              <div className="b2b-trend-bars">
                {report.trend.map((t) => {
                  const pct = trendMax > 0 ? (t.revenue / trendMax) * 100 : 0;
                  return (
                    <div key={t.month} className="b2b-trend-bar-row">
                      <span className="b2b-trend-month">{t.month}</span>
                      <div className="b2b-trend-bar-wrap">
                        <div className="b2b-trend-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="b2b-trend-value b2b-money">{formatMoney(t.revenue)}원</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 업체별 */}
          <div className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head">
              <h2 className="b2b-card-title">업체별 매출</h2>
              <span style={{ fontSize: 10, color: "var(--sm-text-light)" }}>
                {report.by_company.length}개 업체
              </span>
            </div>
            {report.by_company.length === 0 ? (
              <div className="b2b-empty">이 기간에 완료된 발주가 없습니다.</div>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead>
                    <tr>
                      <th>업체</th>
                      <th className="num">발주 수</th>
                      <th className="num">매출</th>
                      <th className="num">마진</th>
                      <th className="num">마진율</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.by_company.map((c) => (
                      <tr key={c.company_name}>
                        <td><strong>{c.company_name}</strong></td>
                        <td className="num">{c.orders}</td>
                        <td className="num b2b-money">{formatMoney(c.revenue)}</td>
                        <td className="num b2b-money">{formatMoney(c.margin)}</td>
                        <td className="num">
                          {c.revenue > 0 ? `${Math.round((c.margin / c.revenue) * 100)}%` : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 제품별 */}
          <div className="b2b-card">
            <div className="b2b-card-head">
              <h2 className="b2b-card-title">제품별 매출</h2>
              <span style={{ fontSize: 10, color: "var(--sm-text-light)" }}>
                {report.by_product.length}개 품목
              </span>
            </div>
            {report.by_product.length === 0 ? (
              <div className="b2b-empty">이 기간에 완료된 발주가 없습니다.</div>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead>
                    <tr>
                      <th>품목</th>
                      <th>옵션</th>
                      <th className="num">수량</th>
                      <th className="num">매출</th>
                      <th className="num">원가</th>
                      <th className="num">마진</th>
                      <th className="num">마진율</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.by_product.map((p) => (
                      <tr key={`${p.product_name} ${p.spec ?? ""}`}>
                        <td><strong>{p.product_name}</strong></td>
                        <td>{p.spec || "-"}</td>
                        <td className="num">{p.qty.toLocaleString()}</td>
                        <td className="num b2b-money">{formatMoney(p.revenue)}</td>
                        <td className="num b2b-money">{formatMoney(p.cost)}</td>
                        <td className="num b2b-money">{formatMoney(p.margin)}</td>
                        <td className="num">
                          {p.revenue > 0 ? `${Math.round((p.margin / p.revenue) * 100)}%` : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function presetLabel(p: Preset): string {
  switch (p) {
    case "this_month": return "이번 달";
    case "last_month": return "지난 달";
    case "this_year": return "올해";
    case "custom": return "직접 선택";
  }
}
