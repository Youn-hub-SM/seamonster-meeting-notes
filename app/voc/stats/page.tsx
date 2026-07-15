"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_CATEGORIES, VOC_STATUS_COLOR, VOC_FAULT_COLOR, type Voc } from "@/app/lib/voc";
import { Donut, PieCard, StackedBar, PIE_COLORS, moneyCompact } from "@/app/components/charts";

type RMode = "7일" | "14일" | "30일" | "custom";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
// 최근 N일 시작일(오늘 포함)
function presetStart(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 - (days - 1) * 86400_000).toISOString().slice(0, 10);
}

type Unit = "일별" | "주별" | "월별";

// 해당 날짜가 속한 주의 월요일(YYYY-MM-DD). 주별 집계 키.
function weekStart(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 월=0 … 일=6
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}
function periodKey(dateStr: string, unit: Unit): string {
  if (!dateStr) return "미지정";
  if (unit === "일별") return dateStr;
  if (unit === "주별") return weekStart(dateStr);
  return dateStr.slice(0, 7);
}
function periodLabel(key: string, unit: Unit): string {
  if (unit === "월별") return key;
  if (unit === "일별") { const d = new Date(key + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }
  // 주별: "M/D~D" 형태
  const s = new Date(key + "T00:00:00");
  const e = new Date(s.getTime() + 6 * 86400_000);
  const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${f(s)}~${f(e)}`;
}
// 단위별 표시 기간 상한(과밀 방지 — 최근분만).
const PERIOD_CAP: Record<Unit, number> = { 일별: 60, 주별: 26, 월별: 18 };

// 키별 집계 → [label, count] 내림차순
function countBy(rows: Voc[], key: (r: Voc) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = (key(r) || "").trim() || "미지정";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// 현황 히어로 도넛/지표 — 처리단계 구성(개선완료·응대개선중·접수). 색은 목록 뱃지와 같은 지도에서.
const STATUS_META: { key: string; color: string }[] = [
  { key: "개선완료", color: VOC_STATUS_COLOR["개선완료"].fg },
  { key: "응대·개선중", color: VOC_STATUS_COLOR["응대·개선중"].fg },
  { key: "접수", color: VOC_STATUS_COLOR["접수"].fg },
];

// 추세 탐색 — 분류 기준(무엇으로 쌓을지) & 측정값
const DIMS = ["유형", "구매처", "구매자", "귀책", "보상유형", "상태", "없음"] as const;
type Dim = (typeof DIMS)[number];
const DIM_FIELD: Record<Dim, (r: Voc) => string> = {
  유형: (r) => r.category || "미지정",
  구매처: (r) => r.purchase_place || "미지정",
  구매자: (r) => r.buyer_type || "미지정",
  귀책: (r) => r.fault || "미분류",
  보상유형: (r) => r.comp_type || "없음",
  상태: (r) => r.status,
  없음: () => "전체 접수",
};
const METRICS = ["건수", "손해금액"] as const;
type Metric = (typeof METRICS)[number];
// 이미 색 지도가 있는 분류축은 그 색으로 그린다 — 안 그러면 같은 '개선완료'가
//  위 히어로에선 초록, 아래 추세에선 PIE_COLORS 순환색으로 나와 설명이 안 된다.
const DIM_COLORS: Partial<Record<Dim, Record<string, string>>> = {
  상태: Object.fromEntries(Object.entries(VOC_STATUS_COLOR).map(([k, v]) => [k, v.fg])),
  귀책: VOC_FAULT_COLOR,
};

export default function VocStatsPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RMode>("30일");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [pUnit, setPUnit] = useState<Unit>("월별");
  const [dim, setDim] = useState<Dim>("유형");
  const [metric, setMetric] = useState<Metric>("건수");

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
    const open = shown.filter((r) => r.status !== "개선완료").length;
    const done = shown.filter((r) => r.status === "개선완료").length;
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

  // 추세 탐색 — 선택한 기간(범위 필터 적용) 안에서 기간단위(pUnit) × 분류(dim)로 측정값(metric) 집계.
  //  하나의 누적 막대로 분류·측정·기간을 토글하며 다양한 관점 관찰.
  const explore = useMemo(() => {
    const fld = DIM_FIELD[dim];
    const labelByKey = new Map<string, string>();
    const matrix = new Map<string, Map<string, number>>(); // 분류값 → periodKey → 측정값
    for (const r of shown) {
      const d = r.received_at || "";
      if (!d) continue;
      const k = periodKey(d, pUnit);
      if (k === "미지정") continue;
      labelByKey.set(k, periodLabel(k, pUnit));
      const g = fld(r);
      const inc = metric === "손해금액" ? (r.loss_amount || 0) : 1;
      const gm = matrix.get(g) || new Map<string, number>();
      gm.set(k, (gm.get(k) || 0) + inc);
      matrix.set(g, gm);
    }
    let keys = [...labelByKey.keys()].sort((a, b) => a.localeCompare(b));
    const cap = PERIOD_CAP[pUnit];
    const capped = keys.length > cap;
    if (capped) keys = keys.slice(-cap);
    const labels = keys.map((k) => labelByKey.get(k)!);
    const groupTotals = [...matrix.entries()]
      .map(([g, m]) => [g, keys.reduce((s, k) => s + (m.get(k) || 0), 0)] as [string, number])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const series = groupTotals.map(([g]) => ({ key: g, values: keys.map((k) => matrix.get(g)?.get(k) || 0) }));
    const grand = groupTotals.reduce((s, [, n]) => s + n, 0);
    const map = DIM_COLORS[dim];
    const colors = map ? groupTotals.map(([g], i) => map[g] || PIE_COLORS[i % PIE_COLORS.length]) : undefined;
    return { labels, series, groupTotals, grand, capped, cap, colors };
  }, [shown, dim, metric, pUnit]);
  const isMoney = metric === "손해금액";
  const fmtVal = (n: number) => (isMoney ? `${n.toLocaleString()}원` : `${n}건`);

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
          <p className="print-only" style={{ fontSize: 13, color: "var(--sm-text-mid)", marginTop: 4 }}>씨몬스터 · 작성일 {TODAY()} · 대상 {period.label}</p>
        </div>
        <div className="b2b-page-actions no-print">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || rows.length === 0}>보고서 인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="sm-tabbar no-print">
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
        <div className="b2b-empty">아직 집계할 VOC가 없습니다. <Link href="/voc" className="sm-link">처리 상태</Link>에서 먼저 등록하세요.</div>
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

          {/* 추세 탐색 — 분류·측정·기간 토글로 하나의 누적 막대를 여러 관점으로 */}
          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span className="b2b-card-title">추세 탐색 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· {period.label}{explore.capped ? ` · 최근 ${explore.cap}개 기간` : ""}</span></span>
              <div className="sm-tabs" style={{ margin: 0 }}>
                {(["일별", "주별", "월별"] as Unit[]).map((u) => (
                  <button key={u} className={`sm-tab ${pUnit === u ? "is-active" : ""}`} onClick={() => setPUnit(u)}>{u}</button>
                ))}
              </div>
            </div>
            <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>분류
                <select className="b2b-input" value={dim} onChange={(e) => setDim(e.target.value as Dim)} style={{ width: "auto" }}>
                  {DIMS.map((d) => <option key={d} value={d}>{d === "없음" ? "전체(분류 없음)" : `${d}별`}</option>)}
                </select></label>
              <div className="sm-tabs" style={{ margin: 0 }}>
                {METRICS.map((m) => <button key={m} className={`sm-tab ${metric === m ? "is-active" : ""}`} onClick={() => setMetric(m)}>{m}</button>)}
              </div>
            </div>
            {explore.series.length === 0 ? (
              <div className="sm-faint" style={{ fontSize: 13, padding: "8px 2px" }}>이 기간에 집계할 데이터가 없습니다.</div>
            ) : (
              <>
                <StackedBar periods={explore.labels} series={explore.series} colors={explore.colors} unit={isMoney ? "원" : "건"} fmtAxis={isMoney ? moneyCompact : undefined} />
                <div className="sm-row-wrap" style={{ gap: 12, marginTop: 10 }}>
                  {explore.groupTotals.map(([g, n], i) => (
                    <span key={g} className="sm-row" style={{ gap: 6, fontSize: 12.5 }}>
                      <span className="sm-stat-hero-dot" style={{ background: explore.colors?.[i] || PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span>{g}</span><strong>{fmtVal(n)}</strong>
                      <span className="sm-faint">{explore.grand ? Math.round((n / explore.grand) * 100) : 0}%</span>
                    </span>
                  ))}
                </div>
                <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>분류·측정·기간을 바꿔 여러 관점으로 관찰하세요. 막대에 올리면 기간·항목별 값이 표시됩니다.</p>
              </>
            )}
          </section>

          {/* 유형별 손해금액 비중(총합) — 시계열은 위 '추세 탐색'에서 측정=손해금액으로 */}
          {kpi.loss > 0 && (
            <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 14 }}>
              <PieCard title="유형별 손해금액 비중(원)" data={lossByCategory} fmt={(n) => n.toLocaleString()} />
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
