"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";
import { DEFAULT_RATES, DEFAULT_EFFECTIVE, ratesFor, type RateVersion } from "@/app/lib/fulfill-rates";
import { ComboBarLine, BarList, ChartLegend, CHART_LINE } from "@/app/components/charts";

type Boxes = Record<string, number>;
type Row = {
  log_date: string; boxes_normal: Boxes; boxes_guar: Boxes;
  base_fee_normal: number; base_fee_guar: number;
  extra_fee: number; guar_extra_fee: number; pado_fee: number; pado_extra: number; pado_cod: number;
  dryice_full: number; dryice_half: number;
};
const won = (n: number) => Math.round(n).toLocaleString();
const sum = (o: Boxes) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월~일

const kstDate = (back = 0) => { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - back); return d; };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function firstOfMonth(monthsBack: number): string { const n = kstDate(0); return iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - monthsBack, 1))); }
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard++ < 120) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
// 그 날짜가 속한 주의 월요일(로컬 기준, UTC 시프트 없이)
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return fmtLocal(d);
}
function weeksBetween(from: string, to: string): string[] {
  const out: string[] = []; let d = new Date(`${mondayOf(from)}T00:00:00`); const end = new Date(`${mondayOf(to)}T00:00:00`);
  let guard = 0;
  while (d <= end && guard++ < 200) { out.push(fmtLocal(d)); d.setDate(d.getDate() + 7); }
  return out;
}
const weekLabel = (mon: string) => { const [, m, d] = mon.split("-"); return `${Number(m)}/${Number(d)}`; };

const PRESETS: { key: string; from: () => string }[] = [
  { key: "3개월", from: () => firstOfMonth(2) },
  { key: "6개월", from: () => firstOfMonth(5) },
  { key: "12개월", from: () => firstOfMonth(11) },
  { key: "올해", from: () => `${kstDate(0).getUTCFullYear()}-01-01` },
];

const NG = ["var(--sm-info)", "var(--sm-orange)"]; // 일반=파랑 · 도착보장=주황

export default function FulfillStatsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [from, setFrom] = useState(firstOfMonth(5));
  const [to] = useState(iso(kstDate(0)));
  const [preset, setPreset] = useState("6개월");
  const [history, setHistory] = useState<RateVersion[]>([{ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/fulfill/rates", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok && j.history?.length) setHistory(j.history); }).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/fulfill/log?from=${from}&to=${to}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const feeTotal = (r: Row) => r.base_fee_normal + r.base_fee_guar + r.extra_fee + r.guar_extra_fee + r.pado_fee + r.pado_extra + r.pado_cod;
  const dryAmt = (r: Row) => { const rt = ratesFor(history, r.log_date); return r.dryice_full * rt.dryFull + r.dryice_half * rt.dryHalf; };

  const agg = useMemo(() => {
    const months = monthsBetween(from, to);
    const weeks = weeksBetween(from, to);
    const mN = new Map<string, number>(), mG = new Map<string, number>(), mFee = new Map<string, number>();
    const wN = new Map<string, number>(), wG = new Map<string, number>(), wFee = new Map<string, number>();
    const mCat: Record<string, Map<string, number>> = {}; for (const c of BOX_CATEGORIES) mCat[c] = new Map();
    const catN = new Map<string, number>(), catG = new Map<string, number>();
    const wdSum = new Array(7).fill(0), wdDays = new Array(7).fill(0);
    let totN = 0, totG = 0, fee = 0, dry = 0, days = 0;

    for (const r of rows) {
      const mo = r.log_date.slice(0, 7), wk = mondayOf(r.log_date);
      const n = sum(r.boxes_normal), g = sum(r.boxes_guar), f = feeTotal(r);
      if (n + g > 0) days++;
      totN += n; totG += g; fee += f; dry += dryAmt(r);
      mN.set(mo, (mN.get(mo) || 0) + n); mG.set(mo, (mG.get(mo) || 0) + g); mFee.set(mo, (mFee.get(mo) || 0) + f);
      wN.set(wk, (wN.get(wk) || 0) + n); wG.set(wk, (wG.get(wk) || 0) + g); wFee.set(wk, (wFee.get(wk) || 0) + f);
      const dow = new Date(`${r.log_date}T00:00:00`).getDay();
      wdSum[dow] += n + g; if (n + g > 0) wdDays[dow]++;
      for (const c of BOX_CATEGORIES) {
        const cn = Number(r.boxes_normal?.[c]) || 0, cg = Number(r.boxes_guar?.[c]) || 0;
        catN.set(c, (catN.get(c) || 0) + cn); catG.set(c, (catG.get(c) || 0) + cg);
        mCat[c].set(mo, (mCat[c].get(mo) || 0) + cn + cg);
      }
    }
    const mLbl = (mo: string) => mo.slice(2);
    return {
      weekly: {
        periods: weeks.map(weekLabel),
        series: [{ key: "일반", values: weeks.map((w) => wN.get(w) || 0) }, { key: "도착보장", values: weeks.map((w) => wG.get(w) || 0) }],
        fee: weeks.map((w) => Math.round(wFee.get(w) || 0)),
      },
      monthly: {
        periods: months.map(mLbl),
        series: [{ key: "일반", values: months.map((m) => mN.get(m) || 0) }, { key: "도착보장", values: months.map((m) => mG.get(m) || 0) }],
        fee: months.map((m) => Math.round(mFee.get(m) || 0)),
      },
      weekdayAvg: WD_ORDER.map((d) => {
        const avg = wdDays[d] ? wdSum[d] / wdDays[d] : 0;
        return { label: WD[d], value: Math.round(avg), days: wdDays[d], total: wdSum[d] };
      }),
      catPie: BOX_CATEGORIES.map((c) => [c, (catN.get(c) || 0) + (catG.get(c) || 0)] as [string, number]).filter(([, v]) => v > 0),
      monthTotals: months.map((m) => ({ month: m, n: mN.get(m) || 0, g: mG.get(m) || 0, cats: BOX_CATEGORIES.map((c) => mCat[c].get(m) || 0) })),
      totN, totG, fee, dry, days,
    };
  }, [rows, from, to, history]); // eslint-disable-line react-hooks/exhaustive-deps

  const tot = agg.totN + agg.totG;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">발송 통계</h1>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div className="sm-tabs" style={{ margin: 0 }}>
            {PRESETS.map((p) => <button key={p.key} className={`sm-tab ${preset === p.key ? "is-active" : ""}`} onClick={() => { setFrom(p.from()); setPreset(p.key); }}>{p.key}</button>)}
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>{from} ~ {to}</span>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : tot === 0 ? (
        <div className="b2b-empty">이 기간에 기록된 발송이 없습니다. <Link href="/fulfill/log">배송일지</Link>에서 먼저 기록하세요.</div>
      ) : (
        <div className="sm-col" style={{ gap: 16 }}>
          {/* KPI */}
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 0 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 발송(택배)</div><div className="b2b-stat-card-value b2b-money">{won(tot)}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">일반 / 도착보장</div><div className="b2b-stat-card-value" style={{ fontSize: 18 }}><span style={{ color: "var(--sm-info)" }}>{won(agg.totN)}</span> <span className="sm-faint">/</span> <span style={{ color: "var(--sm-orange)" }}>{won(agg.totG)}</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">도착보장 비율</div><div className="b2b-stat-card-value">{tot ? Math.round((agg.totG / tot) * 100) : 0}%</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">일평균 발송</div><div className="b2b-stat-card-value b2b-money">{agg.days ? won(tot / agg.days) : 0}<span className="sm-faint" style={{ fontSize: 12 }}> /{agg.days}일</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">운임 합계</div><div className="b2b-stat-card-value b2b-money">{won(agg.fee)}원</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">드라이아이스</div><div className="b2b-stat-card-value b2b-money">{won(agg.dry)}원</div></div>
          </div>

          {/* 1) 주차별 · 2) 월별 발송량 + 운임 — 아래 두 카드와 같은 2열 폭 */}
          <div className="fx-2col">
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">주차별 발송량 + 운임</span></div>
              <ComboBarLine periods={agg.weekly.periods} barSeries={agg.weekly.series} barColors={NG} lineValues={agg.weekly.fee} />
              <ChartLegend style={{ marginTop: 8 }} items={[["일반", NG[0]], ["도착보장", NG[1]], ["운임(선)", CHART_LINE]]} />
            </section>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">월별 발송량 + 운임</span></div>
              <ComboBarLine periods={agg.monthly.periods} barSeries={agg.monthly.series} barColors={NG} lineValues={agg.monthly.fee} />
              <ChartLegend style={{ marginTop: 8 }} items={[["일반", NG[0]], ["도착보장", NG[1]], ["운임(선)", CHART_LINE]]} />
            </section>
          </div>

          {/* 3) 요일별 평균 · 4) 박스종류 비중 */}
          <div className="fx-2col">
            <BarList
              title="요일별 평균 발송량"
              caption="발송한 날 기준 평균 · 월~일"
              accent="var(--sm-info)"
              minPct={7}
              data={agg.weekdayAvg.map((d) => [`${d.label}요일`, d.value] as [string, number])}
              sub={(label) => {
                const d = agg.weekdayAvg.find((x) => `${x.label}요일` === label);
                return d ? `${d.days}일 발송 · 총 ${d.total.toLocaleString()}건` : null;
              }}
            />
            <BarList
              title="박스종류 비중"
              caption={`총 ${won(agg.catPie.reduce((s, [, n]) => s + n, 0))}건`}
              accent="var(--sm-orange)"
              minPct={7}
              sorted
              data={agg.catPie}
              sub={(_, n) => {
                const t = agg.catPie.reduce((s, [, v]) => s + v, 0);
                return t ? `${Math.round((n / t) * 100)}%` : null;
              }}
            />
          </div>

          {/* 월별 박스종류 수량표 */}
          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">월별 박스종류 수량표</span></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table" style={{ fontSize: 12.5 }}>
                <thead><tr><th>월</th>{BOX_CATEGORIES.map((c) => <th key={c} className="num">{c}</th>)}<th className="num">일반</th><th className="num">도착보장</th><th className="num">합계</th></tr></thead>
                <tbody>
                  {agg.monthTotals.map((m) => (
                    <tr key={m.month}>
                      <td><strong>{m.month.slice(2)}</strong></td>
                      {m.cats.map((v, i) => <td key={i} className="num b2b-money">{v || "-"}</td>)}
                      <td className="num b2b-money" style={{ color: "var(--sm-info)" }}>{won(m.n)}</td>
                      <td className="num b2b-money" style={{ color: "var(--sm-orange)" }}>{won(m.g)}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(m.n + m.g)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

