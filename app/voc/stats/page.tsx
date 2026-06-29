"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_CATEGORIES, type Voc } from "@/app/lib/voc";
import { Donut, TrendChart, PieCard, BarList } from "@/app/components/charts";

type RMode = "7일" | "14일" | "30일" | "custom";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
// 최근 N일 시작일(오늘 포함)
function presetStart(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 - (days - 1) * 86400_000).toISOString().slice(0, 10);
}

type Unit = "주별" | "월별";

// 해당 날짜가 속한 주의 월요일(YYYY-MM-DD). 주별 집계 키.
function weekStart(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 월=0 … 일=6
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}
function periodKey(dateStr: string, unit: Unit): string {
  if (!dateStr) return "미지정";
  return unit === "주별" ? weekStart(dateStr) : dateStr.slice(0, 7);
}
function periodLabel(key: string, unit: Unit): string {
  if (unit === "월별") return key;
  // 주별: "M/D 주(~D)" 형태
  const s = new Date(key + "T00:00:00");
  const e = new Date(s.getTime() + 6 * 86400_000);
  const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${f(s)}~${f(e)}`;
}

// 키별 집계 → [label, count] 내림차순
function countBy(rows: Voc[], key: (r: Voc) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = (key(r) || "").trim() || "미지정";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// 현황 히어로 도넛/지표 — 상태 구성(완료·진행중·대기)
const STATUS_META: { key: string; color: string }[] = [
  { key: "완료", color: "var(--sm-success)" },
  { key: "진행중", color: "var(--sm-info)" },
  { key: "대기", color: "var(--sm-warning)" },
];

export default function VocStatsPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RMode>("30일");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [unit, setUnit] = useState<Unit>("주별");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/voc", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const period = useMemo(() => {
    if (mode === "custom") return { from: fromDate || "0000-00-00", to: toDate || TODAY(), label: `${fromDate || "처음"} ~ ${toDate || TODAY()}` };
    const days = mode === "7일" ? 7 : mode === "14일" ? 14 : 30;
    return { from: presetStart(days), to: TODAY(), label: `최근 ${mode}` };
  }, [mode, fromDate, toDate]);
  const shown = useMemo(() => rows.filter((r) => { const d = r.received_at || ""; return d >= period.from && d <= period.to; }), [rows, period]);

  const kpi = useMemo(() => {
    const total = shown.length;
    const open = shown.filter((r) => r.status !== "완료").length;
    const done = shown.filter((r) => r.status === "완료").length;
    const loss = shown.reduce((s, r) => s + (r.loss_amount || 0), 0);
    const rate = total ? Math.round((done / total) * 100) : 0;
    return { total, open, done, rate, loss };
  }, [shown]);

  const byCategory = useMemo(() => {
    const counts = countBy(shown, (r) => r.category);
    const order = new Map(VOC_CATEGORIES.map((c, i) => [c as string, i]));
    return counts.sort((a, b) => (b[1] - a[1]) || ((order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99)));
  }, [shown]);
  const byBuyer = useMemo(() => countBy(shown, (r) => r.buyer_type), [shown]);
  const bySource = useMemo(() => countBy(shown, (r) => r.source), [shown]);
  const byPlace = useMemo(() => countBy(shown, (r) => r.purchase_place), [shown]);
  const statusComp = useMemo(() => STATUS_META.map((s) => ({ ...s, n: shown.filter((r) => r.status === s.key).length })), [shown]);

  // 단위(주/월)별 접수 건수 + 손해금액 — 시간순
  const trend = useMemo(() => {
    const m = new Map<string, { count: number; loss: number }>();
    for (const r of shown) {
      const k = periodKey(r.received_at || "", unit);
      const cur = m.get(k) || { count: 0, loss: 0 };
      cur.count += 1; cur.loss += r.loss_amount || 0;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => ({ key: k, label: periodLabel(k, unit), count: v.count, loss: v.loss }));
  }, [shown, unit]);

  // 유형별 손해금액 (내림차순)
  const lossByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shown) if (r.loss_amount) m.set(r.category, (m.get(r.category) || 0) + r.loss_amount);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [shown]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 통계·보고서</h1>
          <p className="b2b-page-subtitle no-print">클레임을 유형·구매자·기간으로 집계합니다. 제조사 제출용은 <Link href="/voc/reports" className="change-link">개선요청서</Link>에서.</p>
          <p className="print-only" style={{ fontSize: 13, color: "var(--sm-text-mid)", marginTop: 4 }}>씨몬스터 · 작성일 {TODAY()} · 대상 {period.label}</p>
        </div>
        <div className="b2b-page-actions no-print">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || rows.length === 0}>🖨 보고서 인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="no-print" style={{ marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div className="sm-tabs" style={{ margin: 0, flexWrap: "wrap" }}>
          {(["7일", "14일", "30일"] as RMode[]).map((m) => (
            <button key={m} className={`sm-tab ${mode === m ? "is-active" : ""}`} onClick={() => setMode(m)}>{`최근 ${m}`}</button>
          ))}
          <button className={`sm-tab ${mode === "custom" ? "is-active" : ""}`} onClick={() => setMode("custom")}>직접지정</button>
        </div>
        {mode === "custom" && (
          <span className="sm-row" style={{ gap: 6 }}>
            <input className="b2b-input" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} style={{ width: "auto" }} />
            <span className="sm-faint">~</span>
            <input className="b2b-input" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} style={{ width: "auto" }} />
          </span>
        )}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📭</div>아직 집계할 VOC가 없습니다. <Link href="/voc" className="change-link">처리 상태</Link>에서 먼저 등록하세요.</div>
      ) : (
        <>
          <section className="b2b-card sm-stat-hero" style={{ marginBottom: 16 }}>
            <div className="sm-stat-hero-chart">
              <Donut data={statusComp.map((s) => [s.key, s.n] as [string, number])} colors={statusComp.map((s) => s.color)} center={String(kpi.total)} centerSub="총 접수" />
            </div>
            <div className="sm-stat-hero-body">
              <div className="sm-stat-hero-label">총 접수</div>
              <div className="sm-stat-hero-total">{kpi.total}건</div>
              <div className="sm-stat-hero-label" style={{ marginTop: 6 }}>총 손해/보상 <strong style={{ color: "var(--sm-danger)" }}>{kpi.loss.toLocaleString()}원</strong></div>
              <div className="sm-stat-hero-breakdown">
                {statusComp.map((s) => (
                  <div key={s.key} className="sm-stat-hero-metric">
                    <span className="sm-stat-hero-metric-label"><span className="sm-stat-hero-dot" style={{ background: s.color }} />{s.key}</span>
                    <span className="sm-stat-hero-metric-value" style={{ color: s.color }}>
                      {s.n}건 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 600 }}>{kpi.total ? Math.round((s.n / kpi.total) * 100) : 0}%</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 접수·손해 추세 — 주별/월별 토글 */}
          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="b2b-card-title">접수·손해 추세</span>
              <div className="sm-tabs" style={{ margin: 0 }}>
                {(["주별", "월별"] as Unit[]).map((u) => (
                  <button key={u} className={`sm-tab ${unit === u ? "is-active" : ""}`} onClick={() => setUnit(u)}>{u}</button>
                ))}
              </div>
            </div>
            <div className="sm-between" style={{ marginBottom: 6 }}>
              <span className="sm-faint" style={{ fontSize: 11 }}>단위 : 건</span>
              <span className="sm-chart-legend"><span><i style={{ background: "var(--sm-orange)" }} />접수 건수</span></span>
            </div>
            <TrendChart data={trend.map((t) => ({ label: t.label, value: t.count, tip: `${t.label} · ${t.count}건${t.loss > 0 ? ` · 손해 ${t.loss.toLocaleString()}원` : ""}` }))} />
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>막대에 마우스를 올리면 건수·손해금액이 표시됩니다.</p>
          </section>

          {/* 손해금액 집계 */}
          {kpi.loss > 0 && (
            <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginTop: 14 }}>
              <PieCard title="유형별 손해금액(원)" data={lossByCategory} fmt={(n) => n.toLocaleString()} />
              <BarList title={`${unit} 손해금액(원)`} data={trend.filter((t) => t.loss > 0).map((t) => [t.label, t.loss] as [string, number])} accent="var(--sm-danger)" fmt={(n) => n.toLocaleString()} />
            </div>
          )}

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 16 }}>
            <PieCard title="클레임 유형별" data={byCategory} />
            <PieCard title="구매자 구분" data={byBuyer} />
            <PieCard title="수집경로별" data={bySource} />
            <PieCard title="구매처별" data={byPlace} />
          </div>

          {/* 상세 내역 — 보고서용 전체 목록 */}
          <section className="b2b-card" style={{ marginTop: 14 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">상세 내역 ({shown.length}건)</span></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>접수일</th><th>구매자</th><th>유형</th><th>내용</th><th>처리내용</th><th className="num">손해(원)</th><th>상태</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(2)}</td>
                      <td>{r.buyer_type || "-"}</td>
                      <td>{r.category}</td>
                      <td style={{ maxWidth: 280 }}>{r.content}</td>
                      <td style={{ maxWidth: 200 }}>{r.resolution || "-"}</td>
                      <td className="num">{r.loss_amount ? r.loss_amount.toLocaleString() : "-"}</td>
                      <td>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
