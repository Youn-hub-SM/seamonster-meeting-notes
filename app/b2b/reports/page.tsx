"use client";

import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { formatMoney } from "@/app/lib/b2b-orders";
import { Donut, TrendChart, ChartLegend, moneyCompact } from "@/app/components/charts";

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
    margin_cost_missing_lines?: number;
    margin_cost_missing_revenue?: number;
  };
  backlog: {
    pending_orders: number;
    pending_total: number;
  };
  ledger?: { revenue: number | null; diff: number | null; error: string | null };
  by_company: { company_name: string; orders: number; revenue: number; margin: number }[];
  by_product: { product_name: string; spec: string | null; qty: number; revenue: number; cost: number; margin: number }[];
  trend: { month: string; revenue: number }[];
};

type Preset = "this_month" | "last_month" | "this_year" | "custom";

type MismatchKind = "missing" | "differs" | "backfill_dup" | "backfill_only" | "not_completed" | "stale_date";
type Mismatch = { order_id: string; order_no: string; status: string; date: string | null; kind: MismatchKind; expected: number; ledger: number };
const MISMATCH_LABEL: Record<MismatchKind, string> = {
  missing: "원장에 없음",
  differs: "금액·구성 다름",
  backfill_dup: "백필 행 중복",
  backfill_only: "백필 행만 있음",
  not_completed: "발송완료 아님",
  stale_date: "원장 날짜가 발송일과 다름",
};

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
  const confirmModal = useConfirm();
  const [ledgerList, setLedgerList] = useState<{ checked: number; mismatches: Mismatch[] } | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState("");
  const [ledgerErr, setLedgerErr] = useState("");

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
    setLedgerList(null);
    setLedgerErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  // 매출 원장 대조 — 발주 기준 매출과 sales_orders(도매)를 발주 단위로 비교(고치지 않음)
  async function loadLedger() {
    setLedgerBusy("load");
    setLedgerErr("");
    try {
      const res = await fetch(`/api/b2b/reports/ledger?from=${from}&to=${to}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "원장 대조 실패");
      setLedgerList({ checked: j.checked, mismatches: j.mismatches });
    } catch (err) {
      setLedgerErr(err instanceof Error ? err.message : "원장 대조 실패");
    }
    setLedgerBusy("");
  }

  async function resyncOrder(m: Mismatch) {
    const legacy = m.kind === "backfill_dup" || m.kind === "backfill_only";
    if (!(await confirmModal({
      title: `${m.order_no} 매출 원장 다시 맞추기`,
      body: legacy
        ? "지금 발주 상태로 다시 맞춥니다. 백필 행은 지워지고 발송일·부가세 포함 기준으로 다시 들어가 귀속 월·금액이 바뀔 수 있습니다."
        : "지금 발주 상태로 다시 맞춥니다.",
      action: "다시 맞추기",
      danger: legacy,
    }))) return;
    setLedgerBusy(m.order_id);
    setLedgerErr("");
    try {
      const res = await fetch("/api/b2b/reports/ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: m.order_id }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "다시 맞추기 실패");
    } catch (err) {
      setLedgerErr(err instanceof Error ? err.message : "다시 맞추기 실패");
      setLedgerBusy("");
      return;
    }
    setLedgerBusy("");
    await Promise.all([loadLedger(), reload()]);
  }

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

  // 히어로 도넛 — 업체별 매출 비중(상위 6 + 기타)
  const companyDonut = useMemo<[string, number][]>(() => {
    if (!report) return [];
    const sorted = [...report.by_company].sort((a, b) => b.revenue - a.revenue);
    const out = sorted.slice(0, 6).map((c) => [c.company_name, c.revenue] as [string, number]);
    const rest = sorted.slice(6).reduce((s, c) => s + c.revenue, 0);
    if (rest > 0) out.push(["기타", rest]);
    return out;
  }, [report]);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 집계</h1>
          <p className="b2b-page-subtitle">발송일 기준 · 발송완료 발주만</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <button className="b2b-btn-secondary" onClick={loadLedger} disabled={loading || ledgerBusy !== ""}>
            {ledgerBusy === "load" ? "대조 중..." : "원장 대조"}
          </button>
          <button
            className="b2b-btn-primary"
            onClick={handleExport}
            disabled={exporting || loading || !report || report.summary.orders_completed === 0}
            title={report && report.summary.orders_completed === 0 ? "이 기간에 발송완료된 발주가 없습니다" : ""}
          >
            {exporting ? "생성 중..." : "엑셀 다운로드"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {report?.ledger && (report.ledger.error || (report.ledger.diff ?? 0) !== 0) && !ledgerList && (
        <div className="sm-warn">
          {report.ledger.error
            ? `매출 원장 합계를 불러오지 못했습니다 — ${report.ledger.error}`
            : `매출 원장(/sales 도매)과 ${formatMoney(Math.abs(report.ledger.diff ?? 0))}원 차이 — 원장 대조로 발주를 확인하세요`}
        </div>
      )}
      {ledgerErr && <div className="b2b-error">{ledgerErr}</div>}
      {ledgerList && (
        <div className="b2b-card" style={{ marginBottom: 16 }}>
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">매출 원장 대조</h2>
            <button className="b2b-link-btn" onClick={() => setLedgerList(null)}>닫기</button>
          </div>
          {ledgerList.mismatches.length === 0 ? (
            <div className="b2b-empty">발송완료 {ledgerList.checked}건 모두 원장과 같습니다.</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr>
                    <th>발주번호</th>
                    <th>발송일</th>
                    <th>상태</th>
                    <th>내용</th>
                    <th className="num">발주 기준</th>
                    <th className="num">원장</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerList.mismatches.map((m) => (
                    <tr key={`${m.order_id}-${m.kind}`}>
                      <td data-label="발주번호">{m.status === "삭제됨" ? m.order_no : <a className="sm-link" href={`/b2b/orders/${m.order_id}`}>{m.order_no}</a>}</td>
                      <td data-label="발송일">{m.date || "-"}</td>
                      <td data-label="상태">{m.status}</td>
                      <td data-label="내용">{MISMATCH_LABEL[m.kind]}</td>
                      <td data-label="발주 기준" className="num b2b-money">{formatMoney(m.expected)}</td>
                      <td data-label="원장" className="num b2b-money">{formatMoney(m.ledger)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => resyncOrder(m)} disabled={ledgerBusy !== ""}>
                          {ledgerBusy === m.order_id ? "맞추는 중..." : "다시 맞추기"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <div className="sm-tabs">
            {(["this_month", "last_month", "this_year", "custom"] as Preset[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`sm-tab ${preset === p ? "is-active" : ""}`}
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
          {/* 현황 히어로 — 업체별 매출 도넛 + 총매출 + 지표 */}
          <section className="b2b-card sm-stat-hero" style={{ marginBottom: 16 }}>
            <div className="sm-stat-hero-chart">
              <Donut data={companyDonut} center={moneyCompact(report.summary.revenue)} centerSub="총 매출" />
            </div>
            <div className="sm-stat-hero-body">
              <div className="sm-stat-hero-label">총 매출 <span className="sm-faint">· 과세 {formatMoney(report.summary.revenue_taxable)} · 면세 {formatMoney(report.summary.revenue_exempt)}</span></div>
              <div className="sm-stat-hero-total b2b-money">{formatMoney(report.summary.revenue)}원</div>
              <div className="sm-stat-hero-breakdown">
                <div className="sm-stat-hero-metric">
                  <span className="sm-stat-hero-metric-label">발송완료 발주</span>
                  <span className="sm-stat-hero-metric-value">{report.summary.orders_completed}건</span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>건당 평균 {formatMoney(report.summary.avg_order_value)}원</span>
                </div>
                <div className="sm-stat-hero-metric">
                  <span className="sm-stat-hero-metric-label">예상 마진</span>
                  <span className="sm-stat-hero-metric-value" style={{ color: "var(--sm-success)" }}>{formatMoney(report.summary.margin)}원</span>
                  {(report.summary.margin_cost_missing_lines ?? 0) > 0 ? (
                    <span className="sm-faint" style={{ fontSize: 12, color: "var(--sm-danger)" }}>
                      원가 미입력 {report.summary.margin_cost_missing_lines}건(매출 {formatMoney(report.summary.margin_cost_missing_revenue ?? 0)}원) · 마진 과대 가능
                    </span>
                  ) : (
                    <span className="sm-faint" style={{ fontSize: 12 }}>매출 대비 {report.summary.revenue > 0 ? Math.round((report.summary.margin / report.summary.revenue) * 100) : 0}%</span>
                  )}
                </div>
                <div className="sm-stat-hero-metric">
                  <span className="sm-stat-hero-metric-label">미발송 잔고 <span className="sm-faint">(전체 기간)</span></span>
                  <span className="sm-stat-hero-metric-value" style={{ color: "var(--sm-warning)" }}>{formatMoney(report.backlog.pending_total)}원</span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{report.backlog.pending_orders}건 진행 중</span>
                </div>
              </div>
            </div>
          </section>

          {/* 월별 추세 */}
          {report.trend.length > 0 && (
            <div className="b2b-card" style={{ marginBottom: 16 }}>
              <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 className="b2b-card-title">월별 매출 추세</h2>
                <ChartLegend items={[["매출(원)", "var(--sm-orange)"]]} />
              </div>
              <TrendChart data={report.trend.map((t) => ({ label: t.month, value: t.revenue, tip: `${t.month} · ${formatMoney(t.revenue)}원` }))} fmtAxis={moneyCompact} />
            </div>
          )}

          {/* 업체별 */}
          <div className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head">
              <h2 className="b2b-card-title">업체별 매출</h2>
            </div>
            {report.by_company.length === 0 ? (
              <div className="b2b-empty">이 기간에 발송완료된 발주가 없습니다.</div>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table is-responsive">
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
                        <td data-label="업체"><strong>{c.company_name}</strong></td>
                        <td data-label="발주 수" className="num">{c.orders}</td>
                        <td data-label="매출" className="num b2b-money">{formatMoney(c.revenue)}</td>
                        <td data-label="마진" className="num b2b-money">{formatMoney(c.margin)}</td>
                        <td data-label="마진율" className="num">
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
            </div>
            {report.by_product.length === 0 ? (
              <div className="b2b-empty">이 기간에 발송완료된 발주가 없습니다.</div>
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
