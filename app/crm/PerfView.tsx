"use client";

// 성과 — 주간 성과(수단별 발송·클릭·GA, WeeklyStats) + 캠페인별 GA 추이(utm_campaign). 판매 채널 세그먼트가 둘 다에 적용된다. (2026-11-06 개편: 주간 성과 탭 + 통계 탭 통합)
import { useEffect, useMemo, useState } from "react";
import { TrendChart, BarList, moneyCompact } from "@/app/components/charts";
import { qty, wonText } from "@/app/lib/format";
import WeeklyStats from "./WeeklyStats";
import type { Channel } from "./types";

type GaDaily = { date: string; campaign: string; sessions: number; purchases: number; revenue: number };
const STATS_RANGES = [{ d: 7, label: "7일" }, { d: 30, label: "30일" }, { d: 90, label: "90일" }];
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export default function PerfView({ channel, campaigns, gaConfigured }: { channel: Channel; campaigns: string[]; gaConfigured?: boolean }) {
  const [days, setDays] = useState(30);
  const [daily, setDaily] = useState<GaDaily[] | null>(null);
  const [gaErr, setGaErr] = useState("");
  const [loading, setLoading] = useState(false);
  const campaignsKey = campaigns.join(",");

  useEffect(() => {
    if (!campaignsKey || gaConfigured === false) { setDaily(null); return; }
    let alive = true;
    setLoading(true); setGaErr("");
    (async () => {
      try {
        const j = await (await fetch(`/api/crm/ga-stats?campaigns=${encodeURIComponent(campaignsKey)}&days=${days}&daily=1`, { cache: "no-store" })).json();
        if (!alive) return;
        if (!j.ok) throw new Error(j.error || "GA 성과를 불러오지 못했습니다. GA 연동 설정을 확인하세요");
        setDaily(j.configured ? (j.daily || []) : null);
      } catch (e) { if (alive) { setDaily(null); setGaErr(e instanceof Error ? e.message : "GA 성과를 불러오지 못했습니다. GA 연동 설정을 확인하세요"); } }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [campaignsKey, days, gaConfigured]);

  const ga = useMemo(() => {
    if (!daily) return null;
    const byDate = new Map<string, { sessions: number; purchases: number; revenue: number }>();
    const byCampaign = new Map<string, { sessions: number; purchases: number; revenue: number }>();
    for (const r of daily) {
      const d = byDate.get(r.date) || { sessions: 0, purchases: 0, revenue: 0 };
      d.sessions += r.sessions; d.purchases += r.purchases; d.revenue += r.revenue; byDate.set(r.date, d);
      const c = byCampaign.get(r.campaign) || { sessions: 0, purchases: 0, revenue: 0 };
      c.sessions += r.sessions; c.purchases += r.purchases; c.revenue += r.revenue; byCampaign.set(r.campaign, c);
    }
    const dates = [...byDate.keys()].sort();
    type Pt = { label: string; sessions: number; revenue: number };
    let pts: Pt[];
    if (days <= 60) pts = dates.map((d) => ({ label: md(d), sessions: byDate.get(d)!.sessions, revenue: byDate.get(d)!.revenue }));
    else {
      const chunks = new Map<number, Pt>();
      const t0 = dates.length ? Date.parse(dates[0]) : 0;
      for (const d of dates) {
        const i = Math.floor((Date.parse(d) - t0) / (7 * 86_400e3));
        const p = chunks.get(i) || { label: `${md(new Date(t0 + i * 7 * 86_400e3).toISOString().slice(0, 10))}~`, sessions: 0, revenue: 0 };
        p.sessions += byDate.get(d)!.sessions; p.revenue += byDate.get(d)!.revenue; chunks.set(i, p);
      }
      pts = [...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k)!);
    }
    const totals = [...byDate.values()].reduce((t, v) => ({ sessions: t.sessions + v.sessions, purchases: t.purchases + v.purchases, revenue: t.revenue + v.revenue }), { sessions: 0, purchases: 0, revenue: 0 });
    const rank: [string, number][] = [...byCampaign.entries()].map(([c, v]) => [c, v.sessions]);
    const rankSub = (label: string) => { const v = byCampaign.get(label); return v ? `구매 ${qty(v.purchases)} · ${wonText(v.revenue)}` : null; };
    return { pts, totals, rank, rankSub };
  }, [daily, days]);

  return (
    <div>
      <WeeklyStats channel={channel} />

      <section className="crm-perf-sec">
        <div className="crm-perf-head">
          <h2 className="crm-perf-title">캠페인 추이</h2>
          <span className="sm-faint" style={{ fontSize: 12 }}>GA utm_campaign 세션 귀속 · 어제까지</span>
          <span className="crm-summary-spacer" />
          <div className="sm-tabs">
            {STATS_RANGES.map((r) => <button key={r.d} className={`sm-tab ${days === r.d ? "is-active" : ""}`} onClick={() => setDays(r.d)}>{r.label}</button>)}
          </div>
        </div>
        {gaConfigured === false ? (
          <div className="b2b-empty">GA 연동이 아직 없습니다.</div>
        ) : !campaignsKey ? (
          <div className="b2b-empty">UTM 캠페인이 달린 메시지가 없습니다.</div>
        ) : gaErr ? (
          <div className="b2b-error">{gaErr}</div>
        ) : loading && !ga ? (
          <div className="b2b-loading">GA 불러오는 중...</div>
        ) : ga && (
          <>
            <div className="crm-kpis">
              <div className="b2b-stat-card"><div className="b2b-stat-card-label">세션</div><div className="b2b-stat-card-value">{qty(ga.totals.sessions)}</div></div>
              <div className="b2b-stat-card"><div className="b2b-stat-card-label">구매</div><div className="b2b-stat-card-value">{qty(ga.totals.purchases)}</div></div>
              <div className="b2b-stat-card"><div className="b2b-stat-card-label">매출</div><div className="b2b-stat-card-value">{moneyCompact(ga.totals.revenue)}</div></div>
              <div className="b2b-stat-card"><div className="b2b-stat-card-label">캠페인</div><div className="b2b-stat-card-value">{qty(ga.rank.length)}</div></div>
            </div>
            <div className="crm-perf-grid">
              <section className="b2b-card">
                <div className="b2b-card-head"><span className="b2b-card-title">일자별 세션</span></div>
                <TrendChart data={ga.pts.map((p) => ({ label: p.label, value: p.sessions, tip: `${p.label} · 세션 ${qty(p.sessions)}` }))} />
              </section>
              <section className="b2b-card">
                <div className="b2b-card-head"><span className="b2b-card-title">일자별 매출</span></div>
                <TrendChart data={ga.pts.map((p) => ({ label: p.label, value: p.revenue, tip: `${p.label} · ${wonText(p.revenue)}` }))} fmtAxis={moneyCompact} />
              </section>
              <BarList title="캠페인별 세션" caption={`최근 ${days}일`} data={ga.rank} fmt={(n) => qty(n)} sub={ga.rankSub} sorted minPct={2} empty="기간 내 세션 없음" />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
