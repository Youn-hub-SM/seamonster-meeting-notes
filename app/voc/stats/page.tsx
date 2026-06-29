"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_CATEGORIES, type Voc } from "@/app/lib/voc";

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

function BarList({ title, data, accent, fmt }: { title: string; data: [string, number][]; accent?: string; fmt?: (n: number) => string }) {
  const max = data.length ? Math.max(...data.map((d) => d[1])) : 1;
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {data.length === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>데이터 없음</div>
      ) : (
        <div className="sm-col" style={{ gap: 8 }}>
          {data.map(([label, n]) => (
            <div key={label} className="sm-col" style={{ gap: 3 }}>
              <div className="sm-between" style={{ fontSize: 13 }}>
                <span className="sm-ellipsis" style={{ maxWidth: "75%" }}>{label}</span>
                <strong>{fmt ? fmt(n) : n}</strong>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: "var(--sm-bg-subtle)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round((n / max) * 100)}%`, background: accent || "var(--sm-orange)", borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// 카테고리 구분용 팔레트(차트 전용 — 디자인 토큰과 별개, design-system 의 categorical 예외)
const PIE_COLORS = ["#F15A30", "#1971C2", "#22863A", "#B08800", "#C92A2A", "#7C3AED", "#0EA5A4", "#E8590C", "#6B7280", "#DB2777"];

function PieCard({ title, data, fmt }: { title: string; data: [string, number][]; fmt?: (n: number) => string }) {
  const total = data.reduce((s, [, n]) => s + n, 0);
  const R = 42, W = 20, cx = 60, cy = 60, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {total === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>데이터 없음</div>
      ) : (
        <div className="sm-row-wrap" style={{ gap: 16, alignItems: "center" }}>
          <svg viewBox="0 0 120 120" width="118" height="118" style={{ flexShrink: 0 }}>
            {data.map(([label, n], i) => {
              const len = (n / total) * C;
              const seg = (
                <circle key={i} cx={cx} cy={cy} r={R} fill="none" stroke={PIE_COLORS[i % PIE_COLORS.length]}
                  strokeWidth={W} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off}
                  transform={`rotate(-90 ${cx} ${cy})`}><title>{`${label} ${Math.round((n / total) * 100)}%`}</title></circle>
              );
              off += len;
              return seg;
            })}
            {!fmt && <text x={cx} y={cy + 6} textAnchor="middle" fontSize="19" fontWeight="800" fill="var(--sm-black)">{total}</text>}
          </svg>
          <div className="sm-col" style={{ gap: 5, minWidth: 130, flex: 1 }}>
            {data.map(([label, n], i) => (
              <div key={i} className="sm-between" style={{ fontSize: 13, gap: 8 }}>
                <span className="sm-row" style={{ gap: 6, minWidth: 0 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: PIE_COLORS[i % PIE_COLORS.length], flexShrink: 0 }} />
                  <span className="sm-ellipsis">{label}</span>
                </span>
                <span style={{ whiteSpace: "nowrap" }}><strong>{fmt ? fmt(n) : n}</strong> <span className="sm-faint">{Math.round((n / total) * 100)}%</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// 도넛(중앙 총계). colors 미지정 시 PIE_COLORS 순환.
function Donut({ data, colors, size = 132, center, centerSub }: { data: [string, number][]; colors?: string[]; size?: number; center: string; centerSub?: string }) {
  const total = data.reduce((s, [, n]) => s + n, 0);
  const R = 42, W = 18, cx = 60, cy = 60, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--sm-bg-subtle)" strokeWidth={W} />
      {total > 0 && data.map(([label, n], i) => {
        if (n <= 0) return null;
        const len = (n / total) * C;
        const seg = (
          <circle key={i} cx={cx} cy={cy} r={R} fill="none" stroke={colors ? colors[i] : PIE_COLORS[i % PIE_COLORS.length]}
            strokeWidth={W} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off}
            transform={`rotate(-90 ${cx} ${cy})`}><title>{`${label} ${Math.round((n / total) * 100)}%`}</title></circle>
        );
        off += len;
        return seg;
      })}
      <text x={cx} y={cy - 1} textAnchor="middle" fontSize="23" fontWeight="800" fill="var(--sm-black)">{center}</text>
      {centerSub && <text x={cx} y={cy + 15} textAnchor="middle" fontSize="11" fill="var(--sm-text-light)">{centerSub}</text>}
    </svg>
  );
}

// 축 눈금용 — 보기 좋은 상한값(1/2/5 ×10ⁿ)
function niceCeil(n: number): number {
  if (n <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / p;
  const m = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return m * p;
}

// 추세 세로 막대 차트 — 가로 그리드선 + Y축 눈금 + X축 라벨(레퍼런스풍)
function TrendChart({ data }: { data: { label: string; count: number; loss: number }[] }) {
  if (!data.length) return <div className="sm-faint" style={{ fontSize: 13 }}>데이터 없음</div>;
  const top = niceCeil(Math.max(...data.map((d) => d.count), 1));
  const W = 760, H = 230, padL = 28, padR = 10, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / data.length, bw = Math.min(46, slot * 0.5);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(top * f));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--sm-border-light)" strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--sm-text-light)">{t}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + slot * i + slot / 2;
        const yy = y(d.count);
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={yy} width={bw} height={Math.max(0, padT + plotH - yy)} rx={4} fill="var(--sm-orange)">
              <title>{`${d.label} · ${d.count}건${d.loss > 0 ? ` · 손해 ${d.loss.toLocaleString()}원` : ""}`}</title>
            </rect>
            <text x={cx} y={H - 9} textAnchor="middle" fontSize="11" fill="var(--sm-text-mid)">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
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
          <section className="b2b-card voc-hero" style={{ marginBottom: 16 }}>
            <div className="voc-hero-chart">
              <Donut data={statusComp.map((s) => [s.key, s.n] as [string, number])} colors={statusComp.map((s) => s.color)} center={String(kpi.total)} centerSub="총 접수" />
            </div>
            <div className="voc-hero-body">
              <div className="voc-hero-label">총 접수</div>
              <div className="voc-hero-total">{kpi.total}건</div>
              <div className="voc-hero-label" style={{ marginTop: 6 }}>총 손해/보상 <strong style={{ color: "var(--sm-danger)" }}>{kpi.loss.toLocaleString()}원</strong></div>
              <div className="voc-hero-breakdown">
                {statusComp.map((s) => (
                  <div key={s.key} className="voc-hero-metric">
                    <span className="voc-hero-metric-label"><span className="voc-hero-dot" style={{ background: s.color }} />{s.key}</span>
                    <span className="voc-hero-metric-value" style={{ color: s.color }}>
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
              <span className="voc-chart-legend"><span><i style={{ background: "var(--sm-orange)" }} />접수 건수</span></span>
            </div>
            <TrendChart data={trend} />
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
