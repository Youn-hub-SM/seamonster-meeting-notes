"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { TrendChart } from "@/app/components/charts";
import { qty, qtyText, wonText } from "@/app/lib/format";

// CRM 성과(2026-11-09 개편, 대표: "접혀 있지 않아도 펼쳐진 채로 가독성·인사이트", "메시지별 클릭률을 매주 추적") — 접기 없이 구역 카드로 펼친다.
//  위에서부터: 주 이동 한 줄 → 이 주 KPI 4(전주 대비) → 메시지별 클릭률 최근 12주 표(핵심) → 이 주 메시지별 성과 → 주간 클릭률·발송 차트 → 수단별·GA 매체별 → 이 주의 기록.
//  데이터: /api/crm/stats?week= (crm_send_stats + GA 매체별 + 추적 메시지 + history 12주), 솔라피 가져오기 POST, 직접 입력 POST(모달).
//  판매 채널 세그먼트(channel)가 수단·GA 매체·추적 메시지·이력·추이·기록 전부에 적용된다.

type SourceDef = { key: string; label: string; how: "csv" | "api" | "manual" };
type WeeklySource = { source: string; label: string; sent: number; clicked: number | null; cost: number | null; templates: { template: string; label: string; sent: number; clicked: number | null; days: number }[] };
type GaRow = { medium: string; sessions: number; purchases: number; revenue: number };
type StatRow = { id: string; source: string; grain: "day" | "week"; date: string; template: string; sent: number; clicked: number | null; cost: number | null; note: string; batch: string };
type TrackedRow = { id: string; title: string; stage: string; customer: string; medium: string; campaign: string; triggerText: string; sent: number | null; sentBasis: "solapi" | "manual" | "estimate" | "none"; sentNote: string; sessions: number | null; purchases: number | null; revenue: number | null; ctr: number | null; targetCtr: number | null };
type HistoryRow = { id: string; title: string; customer: string; medium: string; campaign: string; targetCtr: number | null; sentBasis: TrackedRow["sentBasis"]; sent: (number | null)[]; sessions: (number | null)[]; ctr: (number | null)[] };
type History = { weeks: string[]; rows: HistoryRow[]; total: { sent: number[]; sessions: (number | null)[]; ctr: (number | null)[] }; note: string };
type Resp = { ok: boolean; error?: string; week: string; until: string; sources: WeeklySource[]; rows: StatRow[]; ga: GaRow[] | null; gaNote: string; trend: { week: string; bySource: Record<string, number> }[]; tracked: TrackedRow[]; trackedNote: string; history?: History | null; sourceDefs: SourceDef[]; solapi: boolean };

const fmtDate = (iso: string) => iso.slice(5).replace("-", "/");
const pct = (a: number | null, b: number) => (a == null || !b ? "-" : `${((a / b) * 100).toFixed(1)}%`);
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shiftDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
// 전주 대비 — 수치는 % 변화, 클릭률은 %p 차이
const diffPct = (cur: number | null | undefined, prev: number | null | undefined): string => (cur == null || prev == null || !prev ? "" : `${cur >= prev ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}%`);
const diffPoint = (cur: number | null | undefined, prev: number | null | undefined): string => (cur == null || prev == null ? "" : `${cur >= prev ? "+" : ""}${(Math.round((cur - prev) * 10) / 10).toFixed(1)}%p`);
const ctrTone = (ctr: number | null, target: number | null) => (ctr == null || target == null ? undefined : ctr >= target ? "var(--sm-success)" : "var(--sm-danger)");

// 발송 수단 → 판매 채널(고객군). 세그먼트가 고객군이면 그 채널 것만 보인다. 없는 키는 '전체'에서만.
const SOURCE_CHANNEL: Record<string, string> = { solapi: "naver", naver_talk: "naver", datarize_brand: "mall", datarize_alimtalk: "mall", blumn: "mall", sms: "mall" };
const MEDIUM_CHANNEL = (medium: string): string => (medium.endsWith("-naver") ? "naver" : medium.endsWith("-cafe24") ? "mall" : "");
const CUSTOMER_LABEL_KEY: Record<string, string> = { "네이버": "naver", "공식몰": "mall", "기타": "etc" };
const inChannel = (channel: string, t: { customer: string; medium: string }) => !channel || (CUSTOMER_LABEL_KEY[t.customer] || t.customer) === channel || (!t.customer && MEDIUM_CHANNEL(t.medium) === channel);

export default function WeeklyStats({ channel = "" }: { channel?: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [week, setWeek] = useState<string>(kstToday());
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [add, setAdd] = useState({ source: "naver_talk", grain: "day", date: kstToday(), template: "", sent: "", clicked: "", note: "" });
  const [addErr, setAddErr] = useState("");

  const load = useCallback(async (w: string) => {
    setLoading(true); setErr("");
    try {
      const j = (await fetch(`/api/crm/stats?week=${w}`, { cache: "no-store" }).then((r) => r.json())) as Resp;
      if (!j.ok) throw new Error(j.error || "성과를 불러오지 못했습니다. [다시 불러오기]를 누르세요");
      setData(j); setWeek(j.week);
    } catch (e) { setErr(e instanceof Error ? e.message : "성과를 불러오지 못했습니다. [다시 불러오기]를 누르세요"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(week); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const go = (n: number) => load(shiftDays(week, 7 * n));

  const syncSolapi = async () => {
    setBusy("solapi");
    try {
      const j = await fetch("/api/crm/stats/solapi", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ since: shiftDays(week, -7), until: data?.until && data.until < kstToday() ? data.until : kstToday() }) }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "솔라피에서 가져오지 못했습니다. 잠시 뒤 다시 누르세요");
      toast.success(`솔라피 ${j.since}~${j.until}: 메시지 ${qtyText(j.messages, "건")} → ${qtyText(j.rows, "줄")} 저장`);
      await load(week);
    } catch (e) { toast.error(e instanceof Error ? e.message : "솔라피에서 가져오지 못했습니다. 잠시 뒤 다시 누르세요"); }
    finally { setBusy(""); }
  };
  const submitAdd = async () => {
    if (!add.date || !add.sent) { setAddErr("날짜와 발송 건수를 입력하세요"); return; }
    setBusy("add"); setAddErr("");
    try {
      const j = await fetch("/api/crm/stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(add) }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "발송 기록을 저장하지 못했습니다. 입력값을 확인하세요");
      setAdd((a) => ({ ...a, template: "", sent: "", clicked: "", note: "" })); setShowAdd(false);
      toast.success("발송 기록을 저장했습니다");
      await load(add.date);
    } catch (e) { setAddErr(e instanceof Error ? e.message : "발송 기록을 저장하지 못했습니다. 입력값을 확인하세요"); }
    finally { setBusy(""); }
  };
  const remove = async (id: string) => {
    if (!(await confirm({ title: "발송 기록 삭제", body: "이 줄을 지웁니다. 되돌릴 수 없습니다.", action: "기록 삭제" }))) return;
    const j = await fetch(`/api/crm/stats?id=${id}`, { method: "DELETE" }).then((r) => r.json());
    if (!j.ok) { toast.error(j.error || "발송 기록을 삭제하지 못했습니다. 다시 시도하세요"); return; }
    toast.success("발송 기록을 삭제했습니다");
    await load(week);
  };

  // 판매 채널 세그먼트 적용
  const v = useMemo(() => {
    if (!data) return null;
    const srcOk = (k: string) => !channel || SOURCE_CHANNEL[k] === channel;
    const sources = data.sources.filter((s) => srcOk(s.source));
    const ga = data.ga ? data.ga.filter((g) => !channel || MEDIUM_CHANNEL(g.medium) === channel) : data.ga;
    const tracked = (data.tracked || []).filter((t) => inChannel(channel, t))
      .slice().sort((a, b) => (b.sent ?? -1) - (a.sent ?? -1) || (b.sessions ?? -1) - (a.sessions ?? -1));
    const rows = data.rows.filter((r) => srcOk(r.source));
    const trend = data.trend.map((t) => ({ week: t.week, bySource: Object.fromEntries(Object.entries(t.bySource).filter(([k]) => srcOk(k))) }));
    const h = data.history && data.history.weeks.length ? data.history : null;
    const hRows = h ? h.rows.filter((r) => inChannel(channel, r)) : [];
    // 합계 줄: 전체 = 수단별 기록 합 ÷ kakao 세션 합(KPI 와 같음), 세그먼트 = 그 채널 메시지 합
    const hTotal = h ? (channel
      ? { sent: h.weeks.map((_, i) => hRows.reduce((s, r) => s + (r.sent[i] ?? 0), 0)), sessions: h.weeks.map((_, i) => (hRows.some((r) => r.sessions[i] != null) ? hRows.reduce((s, r) => s + (r.sessions[i] ?? 0), 0) : null)) }
      : { sent: h.total.sent, sessions: h.total.sessions }) : null;
    const hCtr = h && hTotal ? h.weeks.map((_, i) => (hTotal.sent[i] && hTotal.sessions[i] != null ? Math.round(((hTotal.sessions[i] as number) / hTotal.sent[i]) * 1000) / 10 : null)) : [];
    return { ...data, sources, ga, tracked, rows, trend, h, hRows, hTotal, hCtr };
  }, [data, channel]);
  const totalSent = useMemo(() => (v?.sources || []).reduce((s, x) => s + x.sent, 0), [v]);
  const gaTotal = useMemo(() => (v?.ga || []).reduce((s, g) => ({ sessions: s.sessions + g.sessions, purchases: s.purchases + g.purchases, revenue: s.revenue + g.revenue }), { sessions: 0, purchases: 0, revenue: 0 }), [v]);
  const trendData = useMemo(() => (v?.trend || []).map((t) => { const sum = Object.values(t.bySource).reduce((a, b) => a + b, 0); const tip = Object.entries(t.bySource).map(([k, n]) => `${v?.sourceDefs.find((s) => s.key === k)?.label || k} ${qty(n)}`).join(" · "); return { label: fmtDate(t.week), value: sum, tip: tip || "발송 없음" }; }), [v]);
  // 주간 클릭률 차트 — 축 눈금이 정수로 반올림되므로 ‰(×10) 로 그리고 라벨에서 % 로 되돌린다
  const ctrChart = useMemo(() => (v?.h ? v.h.weeks.map((w, i) => ({ label: fmtDate(w), value: Math.round((v.hCtr[i] ?? 0) * 10), tip: `${fmtDate(w)} 주 · 클릭률 ${v.hCtr[i] == null ? "-" : `${v.hCtr[i]}%`} · 발송 ${qty(v.hTotal?.sent[i] ?? 0)} · 클릭 ${v.hTotal?.sessions[i] == null ? "-" : qty(v.hTotal.sessions[i] as number)}` })) : []), [v]);
  const defs = data?.sourceDefs || [];
  const weekLabel = data ? `${fmtDate(data.week)} ~ ${fmtDate(data.until)}` : week;
  const hasGa = !!v?.ga;
  const last = v?.h ? v.h.weeks.length - 1 : -1;
  const hWeeks = v?.h?.weeks || [];
  const deltaTone = (cur: number | null, prev: number | null) => (cur == null || prev == null ? undefined : cur >= prev ? "var(--sm-success)" : "var(--sm-danger)");
  const prevSent = v?.hTotal && last > 0 ? v.hTotal.sent[last - 1] : null;
  const prevSessions = v?.hTotal && last > 0 ? v.hTotal.sessions[last - 1] : null;
  const prevCtr = v && last > 0 ? v.hCtr[last - 1] : null;
  const curCtr = totalSent && hasGa ? Math.round((gaTotal.sessions / totalSent) * 1000) / 10 : null;

  const histCell = (r: HistoryRow, i: number, isLast: boolean, weeks: string[]) => {
    const c = r.ctr[i], g = r.sessions[i], s = r.sent[i];
    const tone = ctrTone(c, r.targetCtr);
    const title = `${fmtDate(weeks[i])} 주 · 발송 ${s == null ? "-" : qty(s)}${r.sentBasis === "estimate" ? "(추정)" : ""} · 클릭 ${g == null ? "-" : qty(g)}`;
    return (
      <td key={i} className={`num crm-hist-cell${isLast ? " is-this-week" : ""}`} title={title} style={{ color: tone, fontWeight: tone ? 600 : undefined }}>
        {c != null ? `${c}%` : g ? <span className="sm-faint">{qty(g)}회</span> : <span className="sm-faint">·</span>}
      </td>
    );
  };

  return (
    <div>
      <div className="crm-perf-bar">
        <div className="sm-tabs">
          <button className="sm-tab" onClick={() => go(-1)} disabled={loading} aria-label="이전 주">이전 주</button>
          <span className="crm-perf-week num">{weekLabel}</span>
          <button className="sm-tab" onClick={() => go(1)} disabled={loading || week >= kstToday()} aria-label="다음 주">다음 주</button>
        </div>
        <span className="crm-bar-spacer" />
        {data?.solapi && <button className="b2b-btn-secondary" onClick={syncSolapi} disabled={!!busy}>{busy === "solapi" ? "가져오는 중..." : "솔라피 가져오기"}</button>}
        <button className="b2b-btn-secondary" onClick={() => setShowAdd(true)}>발송 기록 입력</button>
      </div>
      {err && <div className="b2b-error">{err}</div>}
      {data && !data.solapi && <div className="b2b-field-hint is-block">솔라피 API 키가 없어 자동 수집이 꺼져 있습니다(Vercel 환경 변수 SOLAPI_API_KEY·SOLAPI_API_SECRET)</div>}

      <div className="crm-kpis">
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">발송</div><div className="b2b-stat-card-value">{loading ? "-" : qty(totalSent)}</div><div className="b2b-stat-card-hint">{!loading && prevSent != null ? `전주 ${qty(prevSent)} ${diffPct(totalSent, prevSent)}`.trim() : "이 주 · 수단별 기록 합"}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">클릭(GA 세션)</div><div className="b2b-stat-card-value">{loading || !hasGa ? "-" : qty(gaTotal.sessions)}</div><div className="b2b-stat-card-hint">{!hasGa ? "GA 연동 없음" : !loading && prevSessions != null ? `전주 ${qty(prevSessions)} ${diffPct(gaTotal.sessions, prevSessions)}`.trim() : "utm_source=kakao"}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">클릭률</div><div className="b2b-stat-card-value">{loading || !hasGa ? "-" : pct(gaTotal.sessions, totalSent)}</div><div className="b2b-stat-card-hint">{!loading && hasGa && prevCtr != null ? `전주 ${prevCtr}% ${diffPoint(curCtr, prevCtr)}`.trim() : "세션 ÷ 발송"}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">구매 · 매출</div><div className="b2b-stat-card-value">{loading || !hasGa ? "-" : qty(gaTotal.purchases)}</div><div className="b2b-stat-card-hint">{hasGa ? wonText(gaTotal.revenue) : ""}</div></div>
      </div>

      <section className="b2b-card crm-perf-sec">
        <div className="b2b-card-head"><span className="b2b-card-title">메시지별 클릭률 · 최근 12주</span><span className="b2b-field-hint">클릭률 = GA 세션 ÷ 발송 · 목표 있는 메시지는 달성 초록, 미달 붉게 · 발송 수 없는 주는 클릭 수만</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : !v?.h ? <div className="b2b-empty">{data?.history?.note || "주간 이력을 불러오지 못했습니다."}</div> : !v.hRows.length ? (
          <div className="b2b-empty">UTM 캠페인이 달린 메시지가 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap crm-hist-wrap">
            <table className="b2b-table crm-hist">
              <thead><tr>
                <th className="crm-hist-title">메시지</th><th className="num">목표</th>
                {v.h.weeks.map((w, i) => <th key={w} className={`num crm-hist-cell${i === last ? " is-this-week" : ""}`}>{i === last ? "이 주" : fmtDate(w)}</th>)}
                <th className="num">전주 대비</th>
              </tr></thead>
              <tbody>
                <tr className="crm-hist-total">
                  <td className="crm-hist-title">{channel ? "합계(이 채널)" : "전체"}<span className="crm-sub">{channel ? "표의 메시지 합" : "수단별 기록 합 ÷ kakao 세션 합"}</span></td>
                  <td className="num sm-faint">-</td>
                  {v.h.weeks.map((w, i) => <td key={w} className={`num crm-hist-cell${i === last ? " is-this-week" : ""}`} title={`${fmtDate(w)} 주 · 발송 ${qty(v.hTotal?.sent[i] ?? 0)} · 클릭 ${v.hTotal?.sessions[i] == null ? "-" : qty(v.hTotal.sessions[i] as number)}`}>{v.hCtr[i] == null ? <span className="sm-faint">·</span> : `${v.hCtr[i]}%`}</td>)}
                  <td className="num">{diffPoint(v.hCtr[last], v.hCtr[last - 1]) || <span className="sm-faint">-</span>}</td>
                </tr>
                {v.hRows.map((r) => (
                  <tr key={r.id}>
                    <td className="crm-hist-title"><div className="crm-ellipsis" title={r.title}>{r.title}</div><span className="crm-sub">{[r.customer, r.campaign, r.sentBasis === "estimate" ? "발송 추정" : r.sentBasis === "none" ? "발송 수 없음" : ""].filter(Boolean).join(" · ")}</span></td>
                    <td className="num">{r.targetCtr != null ? `${r.targetCtr}%` : <span className="sm-faint">-</span>}</td>
                    {hWeeks.map((_, i) => histCell(r, i, i === last, hWeeks))}
                    <td className="num" style={{ color: deltaTone(r.ctr[last], r.ctr[last - 1]) }}>{diffPoint(r.ctr[last], r.ctr[last - 1]) || <span className="sm-faint">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="b2b-card crm-perf-sec">
        <div className="b2b-card-head"><span className="b2b-card-title">이 주 메시지별 성과</span><span className="b2b-field-hint">발송 = 솔라피 실제 → 직접 입력 → 추정 · 구매·매출은 GA 캠페인 기준</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : v?.trackedNote ? <div className="b2b-error">{v.trackedNote}</div> : !v?.tracked?.length ? (
          <div className="b2b-empty">UTM 캠페인이 달린 메시지가 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th className="crm-title-cell">메시지</th><th>수단</th><th>트리거</th><th className="num">발송</th><th className="num">클릭</th><th className="num">클릭률</th><th className="num">구매</th><th className="num">매출</th></tr></thead>
              <tbody>{v.tracked.map((t) => {
                const tone = ctrTone(t.ctr, t.targetCtr);
                return (
                  <tr key={t.id}>
                    <td className="crm-title-cell"><div>{t.title}</div><span className="crm-sub">{[t.stage, t.customer, t.campaign].filter(Boolean).join(" · ")}</span></td>
                    <td className="crm-cell-nowrap">{t.medium || "-"}</td>
                    <td>{(() => { const [head, ...rest] = (t.triggerText || "").split(" · "); return <><span className="crm-cell-nowrap">{head || "-"}</span>{rest.length > 0 && <span className="crm-sub crm-trig-note" title={rest.join(" · ")}>{rest.join(" · ")}</span>}</>; })()}</td>
                    <td className="num" title={t.sentNote}>{t.sent == null ? "-" : qty(t.sent)}{t.sentBasis === "estimate" && <span className="crm-sub">추정</span>}</td>
                    <td className="num">{t.sessions == null ? "-" : qty(t.sessions)}</td>
                    <td className="num" style={{ color: tone, fontWeight: tone ? 600 : undefined }}>{t.ctr == null ? "-" : `${t.ctr}%`}{t.targetCtr != null && <span className="crm-sub">목표 {t.targetCtr}%</span>}</td>
                    <td className="num">{t.purchases == null ? "-" : qty(t.purchases)}</td>
                    <td className="num">{t.revenue == null ? "-" : wonText(t.revenue)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <div className="crm-perf-grid">
        <section className="b2b-card crm-perf-sec">
          <div className="b2b-card-head"><span className="b2b-card-title">주간 클릭률</span><span className="b2b-field-hint">{channel ? "이 채널 메시지 합" : "전체"} · 최근 12주</span></div>
          {loading ? <div className="b2b-loading">불러오는 중...</div> : !v?.h || !hasGa ? <div className="b2b-empty">{!hasGa ? "GA 연동 없음" : "주간 이력 없음"}</div> : <TrendChart data={ctrChart} fmtAxis={(n) => `${n / 10}%`} />}
        </section>
        <section className="b2b-card crm-perf-sec">
          <div className="b2b-card-head"><span className="b2b-card-title">주간 발송</span><span className="b2b-field-hint">수단별 기록 합 · 최근 12주</span></div>
          {loading ? <div className="b2b-loading">불러오는 중...</div> : <TrendChart data={trendData} />}
        </section>
      </div>

      <div className="crm-perf-grid">
        <section className="b2b-card crm-perf-sec">
          <div className="b2b-card-head"><span className="b2b-card-title">수단별 발송</span><span className="crm-group-count">{loading ? "" : qtyText(totalSent, "건")}</span></div>
          {loading ? <div className="b2b-loading">불러오는 중...</div> : !v?.sources.length ? <div className="b2b-empty">이 주의 발송 기록이 없습니다.</div> : (
            <div className="b2b-table-wrap"><table className="b2b-table">
              <thead><tr><th>발송 수단</th><th className="num">발송</th><th className="num">클릭</th><th className="num">클릭률</th><th>수집</th></tr></thead>
              <tbody>{v.sources.map((s) => {
                const def = defs.find((d) => d.key === s.source);
                return [
                  <tr key={s.source}><td>{s.label}</td><td className="num">{qty(s.sent)}</td><td className="num">{s.clicked == null ? "-" : qty(s.clicked)}</td><td className="num">{pct(s.clicked, s.sent)}</td><td className="sm-faint">{def?.how === "api" ? "API" : def?.how === "csv" ? "CSV" : "직접"}</td></tr>,
                  ...s.templates.map((t) => (
                    <tr key={`${s.source}:${t.template}`}><td className="crm-sub-row" title={t.template}>{t.label || t.template || "(이름 없음)"} <span className="sm-faint">· {t.days}일</span></td><td className="num">{qty(t.sent)}</td><td className="num">{t.clicked == null ? "-" : qty(t.clicked)}</td><td className="num">{pct(t.clicked, t.sent)}</td><td /></tr>
                  )),
                ];
              })}</tbody>
            </table></div>
          )}
        </section>
        <section className="b2b-card crm-perf-sec">
          <div className="b2b-card-head"><span className="b2b-card-title">랜딩 성과 · GA 매체별</span><span className="crm-group-count">{hasGa && !loading ? `세션 ${qty(gaTotal.sessions)}` : ""}</span></div>
          {loading ? <div className="b2b-loading">불러오는 중...</div> : v?.ga === null ? <div className="b2b-empty">{v?.gaNote || "GA4 가 연결되어 있지 않습니다."}</div> : !v?.ga?.length ? <div className="b2b-empty">이 주에 kakao 로 들어온 세션이 없습니다.</div> : (
            <div className="b2b-table-wrap"><table className="b2b-table">
              <thead><tr><th>매체(utm_medium)</th><th className="num">세션</th><th className="num">구매</th><th className="num">구매전환율</th><th className="num">매출</th></tr></thead>
              <tbody>{v.ga.map((g) => (<tr key={g.medium}><td>{g.medium}</td><td className="num">{qty(g.sessions)}</td><td className="num">{qty(g.purchases)}</td><td className="num">{pct(g.purchases, g.sessions)}</td><td className="num">{wonText(g.revenue)}</td></tr>))}</tbody>
            </table></div>
          )}
          <p className="b2b-field-hint is-below">GA 는 어제까지 확정값 · 매체 이름은 utm 규칙(메시지종류-경로)</p>
        </section>
      </div>

      <section className="b2b-card crm-perf-sec">
        <div className="b2b-card-head"><span className="b2b-card-title">이 주의 기록</span><span className="crm-group-count">{v?.rows.length ? qtyText(v.rows.length, "줄") : ""}</span></div>
        {!v?.rows.length ? <div className="b2b-empty">기록이 없습니다.</div> : (
          <div className="b2b-table-wrap"><table className="b2b-table">
            <thead><tr><th>날짜</th><th>수단</th><th>템플릿·캠페인</th><th className="num">발송</th><th className="num">클릭</th><th>메모</th><th>출처</th><th /></tr></thead>
            <tbody>{v.rows.map((r) => (
              <tr key={r.id}>
                <td className="crm-cell-nowrap">{r.date}{r.grain === "week" ? " 주" : ""}</td>
                <td>{defs.find((d) => d.key === r.source)?.label || r.source}</td>
                <td className="crm-ellipsis" title={r.template}>{r.batch === "solapi-sync" && r.note ? r.note.split(" · ")[0] : (r.template || "-")}</td>
                <td className="num">{qty(r.sent)}</td>
                <td className="num">{r.clicked == null ? "-" : qty(r.clicked)}</td>
                <td className="sm-faint">{r.note || ""}</td>
                <td className="sm-faint">{r.batch === "solapi-sync" ? "솔라피 API" : r.batch === "manual" ? "직접 입력" : r.batch || "-"}</td>
                <td><button className="b2b-link-btn" onClick={() => remove(r.id)}>삭제</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {showAdd && (
        <div className="b2b-modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="b2b-modal crm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head"><h2 className="b2b-modal-title">발송 기록 입력</h2><button className="b2b-modal-close" aria-label="닫기" onClick={() => setShowAdd(false)}>✕</button></div>
            <div className="b2b-modal-body">
              {addErr && <div className="b2b-error">{addErr}</div>}
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">발송 수단</span>
                  <select className="b2b-select" value={add.source} onChange={(e) => setAdd({ ...add, source: e.target.value })}>{defs.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
                <label className="b2b-field"><span className="b2b-field-label">단위</span>
                  <select className="b2b-select" value={add.grain} onChange={(e) => setAdd({ ...add, grain: e.target.value })}><option value="day">일별(그 날)</option><option value="week">주별(주 시작일)</option></select></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">날짜<span className="req">*</span></span><input className="b2b-input" type="date" value={add.date} onChange={(e) => setAdd({ ...add, date: e.target.value })} /></label>
                <label className="b2b-field"><span className="b2b-field-label">템플릿·캠페인 이름</span><input className="b2b-input" value={add.template} onChange={(e) => setAdd({ ...add, template: e.target.value })} /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">발송 건수<span className="req">*</span></span><input className="b2b-input" type="number" min={0} value={add.sent} onChange={(e) => setAdd({ ...add, sent: e.target.value })} /></label>
                <label className="b2b-field"><span className="b2b-field-label">클릭 수 <span className="opt">모르면 비움</span></span><input className="b2b-input" type="number" min={0} value={add.clicked} onChange={(e) => setAdd({ ...add, clicked: e.target.value })} /></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">메모</span><input className="b2b-input" value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} /></label>
            </div>
            <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right">
              <button className="b2b-btn-secondary" onClick={() => setShowAdd(false)} disabled={busy === "add"}>그만두기</button>
              <button className="b2b-btn-primary" onClick={submitAdd} disabled={busy === "add"}>{busy === "add" ? "저장 중..." : "기록 저장"}</button>
            </div></div>
          </div>
        </div>
      )}
    </div>
  );
}
