"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WeeklyStats } from "@/app/lib/sales-report";

// 주간 매출 브리핑 — 지난주(월~일) 매출을 카드·표로 훑는 화면. 자동 발송 없음(대표 결정).
//  데이터는 매출 원장(sales_orders) 단일 소스: B2B(도매)는 발송완료 시 원장에 채널 '도매'로
//  들어가 있으므로 총매출에 이미 포함돼 있고, 여기서는 그 줄을 강조해 병기한다 —
//  orders 테이블 숫자를 총합에 더하면 이중 집계라 금지.

const won = (v: number) => `${Math.round(v).toLocaleString()}원`;
// 로컬 파싱 → 로컬 출력으로 통일한다. toISOString 은 UTC 라 KST 브라우저에서 하루가 밀린다.
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const md = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
};

// 전주 대비 표기 — 금액·% 를 함께, 색은 증가=성공/감소=위험
function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0 && cur === 0) return <span className="sm-faint">-</span>;
  if (prev === 0) return <span style={{ color: "var(--sm-success)" }}>신규</span>;
  const diff = cur - prev;
  const pct = (Math.abs(diff) / prev) * 100;
  if (diff === 0) return <span className="sm-faint">변동 없음</span>;
  return (
    <span style={{ color: diff > 0 ? "var(--sm-success)" : "var(--sm-danger)", whiteSpace: "nowrap" }}>
      {diff > 0 ? "▲" : "▼"} {won(Math.abs(diff))} ({pct.toFixed(1)}%)
    </span>
  );
}

export default function WeeklyBriefPage() {
  const [base, setBase] = useState<string | null>(null); // null = 최근 완료된 주(API 기본)
  const [stats, setStats] = useState<WeeklyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (b: string | null) => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/sales/report/weekly${b ? `?base=${b}` : ""}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setStats(j.stats as WeeklyStats);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(base); }, [load, base]);

  // 다음 주 버튼 — 미래 주는 막는다(진행 중인 이번 주까지는 허용)
  const nextStart = stats ? addDays(stats.week_start, 7) : null;
  const canNext = !!nextStart && nextStart <= kstToday();

  const channels = useMemo(() => {
    if (!stats) return [];
    return [...stats.channels].sort((a, b) => b.week - a.week);
  }, [stats]);
  const b2b = channels.find((c) => c.name === "도매");
  const top5 = (stats?.top10 ?? []).slice(0, 5);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">주간 매출 브리핑</h1>
          {stats && (
            <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>
              {md(stats.week_start)} ~ {md(stats.week_end)} · 전주 대비
            </span>
          )}
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" disabled={loading || !stats}
            onClick={() => stats && setBase(addDays(stats.week_start, -7))}>← 전주</button>
          <button className="b2b-btn-secondary" disabled={loading || !canNext}
            onClick={() => stats && setBase(addDays(stats.week_start, 7))}>다음 주 →</button>
          {base && <button className="b2b-btn-secondary" disabled={loading} onClick={() => setBase(null)}>최근 주</button>}
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : stats && (
        <>
          {/* 요약 카드 */}
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: 20 }}>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">주간 총매출</div>
              <div className="b2b-stat-card-value b2b-money">{won(stats.week_sales)}</div>
              <div className="b2b-stat-card-hint"><Delta cur={stats.week_sales} prev={stats.prev_week_sales} /> · 전주 {won(stats.prev_week_sales)}</div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">주문 수</div>
              <div className="b2b-stat-card-value b2b-money">{stats.order_count.toLocaleString()}건</div>
              <div className="b2b-stat-card-hint">객단가 {won(stats.aov)}</div>
            </div>
            <div className="b2b-stat-card">
              <div className="b2b-stat-card-label">B2B(도매)</div>
              {b2b ? (
                <>
                  <div className="b2b-stat-card-value b2b-money">{won(b2b.week)}</div>
                  <div className="b2b-stat-card-hint"><Delta cur={b2b.week} prev={b2b.prev_week} /> · 전주 {won(b2b.prev_week)}</div>
                </>
              ) : (
                <div className="b2b-stat-card-value" style={{ fontSize: 17, fontWeight: 500, color: "var(--sm-text-light)" }}>이번 주 없음</div>
              )}
            </div>
          </div>

          {/* 채널별 매출 */}
          <section className="b2b-card" style={{ marginBottom: 20 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">채널별 매출</span></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>채널</th><th className="num">이번 주</th><th className="num">전주</th><th className="num">증감</th></tr></thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.name} style={c.name === "도매" ? { background: "var(--sm-orange-light)" } : undefined}>
                      <td>{c.name}{c.name === "도매" && <span className="b2b-status-pill" style={{ marginLeft: 6, background: "var(--sm-white)", color: "var(--sm-orange)" }}>B2B</span>}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(c.week)}</td>
                      <td className="num b2b-money">{won(c.prev_week)}</td>
                      <td className="num"><Delta cur={c.week} prev={c.prev_week} /></td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                    <td>합계</td>
                    <td className="num">{won(stats.week_sales)}</td>
                    <td className="num">{won(stats.prev_week_sales)}</td>
                    <td className="num"><Delta cur={stats.week_sales} prev={stats.prev_week_sales} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 상위 품목 */}
          <section className="b2b-card" style={{ marginBottom: 20 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">상위 품목 TOP 5 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 13 }}>(품목코드 기준)</span></span></div>
            {top5.length === 0 ? <div className="b2b-empty">판매 내역이 없습니다.</div> : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th style={{ width: 60 }}>순위</th><th>품목코드</th><th className="num">매출</th><th className="num">비중</th></tr></thead>
                  <tbody>
                    {top5.map((t) => (
                      <tr key={t.rank}>
                        <td>{t.rank}위</td>
                        <td style={{ fontFamily: "var(--sm-mono)" }}>{t.code}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(t.revenue)}</td>
                        <td className="num sm-faint">{stats.week_sales > 0 ? `${(t.revenue / stats.week_sales * 100).toFixed(1)}%` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="sm-faint" style={{ fontSize: 12, lineHeight: 1.7 }}>
            ※ 매출 원장(업로드된 정산 데이터) 기준입니다. 소매는 적재 시점 결제금액이라 사후 환불은 재업로드 전까지 반영되지 않고, 카페24는 할인 반영 전 금액입니다.<br />
            ※ 도매(B2B)는 발주가 발송완료될 때 공급가 기준으로 발주일에 귀속됩니다 — 지난주 발주가 이번 주에 발송완료되면 지난주 숫자가 소급해 커질 수 있습니다.
          </p>
        </>
      )}
    </div>
  );
}
