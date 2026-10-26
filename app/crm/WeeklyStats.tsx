"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TrendChart } from "@/app/components/charts";
import { qty, qtyText, wonText } from "@/app/lib/format";

// CRM 주간 성과(2026-10-26, docs/crm-dashboard-plan.md) — 수단별 발송·클릭(crm_send_stats) + GA 매체별 세션·구매·매출 + 12주 추이 + 직접 입력.
//  솔라피는 [가져오기] 버튼(API), 데이터라이즈·블룸은 CSV 업로드(2단계), 네이버 톡톡·톡스토어·문자는 직접 입력.

type SourceDef = { key: string; label: string; how: "csv" | "api" | "manual" };
type WeeklySource = { source: string; label: string; sent: number; clicked: number | null; cost: number | null; templates: { template: string; sent: number; clicked: number | null; days: number }[] };
type GaRow = { medium: string; sessions: number; purchases: number; revenue: number };
type StatRow = { id: string; source: string; grain: "day" | "week"; date: string; template: string; sent: number; clicked: number | null; cost: number | null; note: string; batch: string };
type TrackedRow = { id: string; title: string; stage: string; customer: string; medium: string; campaign: string; triggerText: string; sent: number | null; sentBasis: "solapi" | "manual" | "estimate" | "none"; sentNote: string; sessions: number | null; purchases: number | null; revenue: number | null; ctr: number | null; targetCtr: number | null };
type Resp = { ok: boolean; error?: string; week: string; until: string; sources: WeeklySource[]; rows: StatRow[]; ga: GaRow[] | null; gaNote: string; trend: { week: string; bySource: Record<string, number> }[]; tracked: TrackedRow[]; trackedNote: string; sourceDefs: SourceDef[]; solapi: boolean };

const fmtDate = (iso: string) => iso.slice(5).replace("-", "/");
const pct = (a: number | null, b: number) => (a == null || !b ? "-" : `${((a / b) * 100).toFixed(1)}%`);
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shiftDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

export default function WeeklyStats() {
  const [week, setWeek] = useState<string>(kstToday());
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [add, setAdd] = useState({ source: "naver_talk", grain: "day", date: kstToday(), template: "", sent: "", clicked: "", note: "" });

  const load = useCallback(async (w: string) => {
    setLoading(true); setErr("");
    try {
      const j = (await fetch(`/api/crm/stats?week=${w}`, { cache: "no-store" }).then((r) => r.json())) as Resp;
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setData(j); setWeek(j.week);
    } catch (e) { setErr(e instanceof Error ? e.message : "조회 실패"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(week); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const go = (n: number) => load(shiftDays(week, 7 * n));

  const syncSolapi = async () => {
    setBusy("solapi"); setMsg("");
    try {
      const j = await fetch("/api/crm/stats/solapi", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ since: shiftDays(week, -7), until: data?.until && data.until < kstToday() ? data.until : kstToday() }) }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "가져오기 실패");
      setMsg(`솔라피 ${j.since}~${j.until}: 메시지 ${qtyText(j.messages, "건")} → ${qtyText(j.rows, "줄")} 저장`);
      await load(week);
    } catch (e) { setMsg(e instanceof Error ? e.message : "가져오기 실패"); }
    finally { setBusy(""); }
  };

  const submitAdd = async () => {
    setBusy("add"); setMsg("");
    try {
      const j = await fetch("/api/crm/stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(add) }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setAdd((a) => ({ ...a, template: "", sent: "", clicked: "", note: "" })); setShowAdd(false);
      await load(add.date);
    } catch (e) { setMsg(e instanceof Error ? e.message : "저장 실패"); }
    finally { setBusy(""); }
  };

  const remove = async (id: string) => {
    if (!window.confirm("이 줄을 지웁니다. 되돌릴 수 없습니다.")) return;
    const j = await fetch(`/api/crm/stats?id=${id}`, { method: "DELETE" }).then((r) => r.json());
    if (!j.ok) { setMsg(j.error || "삭제 실패"); return; }
    await load(week);
  };

  const totalSent = useMemo(() => (data?.sources || []).reduce((s, x) => s + x.sent, 0), [data]);
  const gaTotal = useMemo(() => (data?.ga || []).reduce((s, g) => ({ sessions: s.sessions + g.sessions, purchases: s.purchases + g.purchases, revenue: s.revenue + g.revenue }), { sessions: 0, purchases: 0, revenue: 0 }), [data]);
  const trendData = useMemo(() => (data?.trend || []).map((t) => { const sum = Object.values(t.bySource).reduce((a, b) => a + b, 0); const tip = Object.entries(t.bySource).map(([k, v]) => `${data?.sourceDefs.find((s) => s.key === k)?.label || k} ${qty(v)}`).join(" · "); return { label: fmtDate(t.week), value: sum, tip: tip || "발송 없음" }; }), [data]);
  const defs = data?.sourceDefs || [];

  return (
    <div>
      <div className="sm-row-wrap" style={{ gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button className="b2b-btn-secondary" onClick={() => go(-1)} disabled={loading}>◀ 이전 주</button>
        <strong style={{ fontSize: 15 }}>{data ? `${fmtDate(data.week)} ~ ${fmtDate(data.until)}` : week} 주</strong>
        <button className="b2b-btn-secondary" onClick={() => go(1)} disabled={loading || week >= kstToday()}>다음 주 ▶</button>
        <span className="crm-summary-spacer" />
        {data?.solapi ? <button className="b2b-btn-secondary" onClick={syncSolapi} disabled={!!busy}>{busy === "solapi" ? "가져오는 중..." : "솔라피 가져오기"}</button>
          : <span className="sm-faint" style={{ fontSize: 12 }}>솔라피 API 키 없음(Vercel 환경 변수 SOLAPI_API_KEY·SOLAPI_API_SECRET)</span>}
        <button className="b2b-btn-secondary" onClick={() => setShowAdd((v) => !v)}>{showAdd ? "입력 닫기" : "직접 입력"}</button>
      </div>
      {err && <div className="b2b-error">{err}</div>}
      {msg && <div className="sm-success" style={{ marginBottom: 10 }}>{msg}</div>}

      {showAdd && (
        <section className="b2b-card" style={{ marginBottom: 14 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">발송 기록 직접 입력</span></div>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">발송 수단</span>
              <select className="b2b-input" value={add.source} onChange={(e) => setAdd({ ...add, source: e.target.value })}>{defs.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
            <label className="b2b-field"><span className="b2b-field-label">단위</span>
              <select className="b2b-input" value={add.grain} onChange={(e) => setAdd({ ...add, grain: e.target.value })}><option value="day">일별(그 날)</option><option value="week">주별(주 시작일)</option></select></label>
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">날짜</span><input className="b2b-input" type="date" value={add.date} onChange={(e) => setAdd({ ...add, date: e.target.value })} /></label>
            <label className="b2b-field"><span className="b2b-field-label">템플릿·캠페인 이름</span><input className="b2b-input" value={add.template} onChange={(e) => setAdd({ ...add, template: e.target.value })} placeholder="예: 추석 프로모션 톡톡" /></label>
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">발송 건수</span><input className="b2b-input" type="number" min={0} value={add.sent} onChange={(e) => setAdd({ ...add, sent: e.target.value })} /></label>
            <label className="b2b-field"><span className="b2b-field-label">클릭 수</span><input className="b2b-input" type="number" min={0} value={add.clicked} onChange={(e) => setAdd({ ...add, clicked: e.target.value })} placeholder="모르면 비움" /></label>
          </div>
          <label className="b2b-field"><span className="b2b-field-label">메모</span><input className="b2b-input" value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} placeholder="대상·쿠폰 등" /></label>
          <div className="sm-row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <button className="b2b-btn-primary" onClick={submitAdd} disabled={busy === "add" || !add.date || !add.sent}>{busy === "add" ? "저장 중..." : "저장"}</button>
          </div>
        </section>
      )}

      <section className="b2b-card" style={{ marginBottom: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">추적 메시지 클릭률 (utm 단 메시지)</span><span className="sm-faint" style={{ fontSize: 12, marginLeft: "auto" }}>클릭률 = GA 세션 ÷ 발송 수</span></div>
        {loading ? <p className="sm-faint">불러오는 중...</p> : data?.trackedNote ? <div className="b2b-error">{data.trackedNote}</div> : !data?.tracked?.length ? <p className="sm-faint" style={{ fontSize: 13 }}>메시지맵에 UTM 캠페인이 적힌 메시지가 없습니다. 표(편집) 탭에서 UTM 캠페인을 넣으면 여기 나타납니다.</p> : (
          <div className="b2b-table-wrap"><table className="b2b-table">
            <thead><tr><th>메시지</th><th>트리거</th><th>매체</th><th className="num">발송</th><th className="num">클릭(세션)</th><th className="num">클릭률</th><th className="num">구매</th><th className="num">매출</th></tr></thead>
            <tbody>{data.tracked.map((t) => {
              const tone = t.ctr == null || t.targetCtr == null ? undefined : t.ctr >= t.targetCtr ? "var(--sm-success)" : "var(--sm-danger)";
              return (
                <tr key={t.id}>
                  <td><div>{t.title}</div><div className="sm-faint" style={{ fontSize: 12 }}>{[t.stage, t.customer, t.campaign].filter(Boolean).join(" · ")}</div></td>
                  <td style={{ whiteSpace: "nowrap" }}>{t.triggerText || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{t.medium || "-"}</td>
                  <td className="num" title={t.sentNote}>{t.sent == null ? "-" : qty(t.sent)}{t.sentBasis === "estimate" && <span className="sm-faint" style={{ fontSize: 11 }}> 추정</span>}</td>
                  <td className="num">{t.sessions == null ? "-" : qty(t.sessions)}</td>
                  <td className="num" style={{ color: tone, fontWeight: tone ? 700 : undefined }}>{t.ctr == null ? "-" : `${t.ctr}%`}{t.targetCtr != null && <span className="sm-faint" style={{ fontSize: 11 }}> /{t.targetCtr}%</span>}</td>
                  <td className="num">{t.purchases == null ? "-" : qty(t.purchases)}</td>
                  <td className="num">{t.revenue == null ? "-" : wonText(t.revenue)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>발송 수는 솔라피 템플릿 ID 가 있으면 실제, 직접 입력이 있으면 그 값, 둘 다 없으면 트리거·D+n 으로 매출 원장에서 센 대상자 수(추정 — 실제 발송보다 많음). 클릭은 GA 세션으로 통일합니다.</p>
      </section>

      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 }}>
        <section className="b2b-card">
          <div className="b2b-card-head"><span className="b2b-card-title">수단별 발송</span><span className="sm-faint" style={{ fontSize: 12, marginLeft: "auto" }}>합계 {qtyText(totalSent, "건")}</span></div>
          {loading ? <p className="sm-faint">불러오는 중...</p> : !data?.sources.length ? <p className="sm-faint" style={{ fontSize: 13 }}>이 주의 발송 기록이 없습니다. 솔라피는 [솔라피 가져오기], 데이터라이즈·블룸은 CSV 업로드(준비 중), 나머지는 [직접 입력].</p> : (
            <div className="b2b-table-wrap"><table className="b2b-table">
              <thead><tr><th>발송 수단</th><th className="num">발송</th><th className="num">클릭</th><th className="num">클릭률</th><th>수집</th></tr></thead>
              <tbody>
                {data.sources.map((s) => {
                  const def = defs.find((d) => d.key === s.source);
                  const isOpen = !!open[s.source];
                  return [
                    <tr key={s.source} className="is-clickable" onClick={() => setOpen((o) => ({ ...o, [s.source]: !o[s.source] }))} style={{ cursor: "pointer" }}>
                      <td>{isOpen ? "▾" : "▸"} {s.label}</td>
                      <td className="num">{qty(s.sent)}</td>
                      <td className="num">{s.clicked == null ? "-" : qty(s.clicked)}</td>
                      <td className="num">{pct(s.clicked, s.sent)}</td>
                      <td className="sm-faint" style={{ fontSize: 12 }}>{def?.how === "api" ? "API" : def?.how === "csv" ? "CSV" : "직접"}</td>
                    </tr>,
                    ...(isOpen ? s.templates.map((t) => (
                      <tr key={`${s.source}:${t.template}`} style={{ background: "var(--sm-bg-subtle)" }}>
                        <td style={{ paddingLeft: 28, fontSize: 13 }}>{t.template || "(이름 없음)"} <span className="sm-faint">· {t.days}일</span></td>
                        <td className="num" style={{ fontSize: 13 }}>{qty(t.sent)}</td>
                        <td className="num" style={{ fontSize: 13 }}>{t.clicked == null ? "-" : qty(t.clicked)}</td>
                        <td className="num" style={{ fontSize: 13 }}>{pct(t.clicked, t.sent)}</td>
                        <td />
                      </tr>
                    )) : []),
                  ];
                })}
              </tbody>
            </table></div>
          )}
        </section>

        <section className="b2b-card">
          <div className="b2b-card-head"><span className="b2b-card-title">랜딩 성과 (GA · utm source=kakao)</span><span className="sm-faint" style={{ fontSize: 12, marginLeft: "auto" }}>{data?.ga ? `세션 ${qty(gaTotal.sessions)} · 구매 ${qty(gaTotal.purchases)} · ${wonText(gaTotal.revenue)}` : ""}</span></div>
          {loading ? <p className="sm-faint">불러오는 중...</p> : data?.ga === null ? <p className="sm-faint" style={{ fontSize: 13 }}>{data?.gaNote || "GA4 가 연결되어 있지 않습니다."}</p> : !data?.ga?.length ? <p className="sm-faint" style={{ fontSize: 13 }}>이 주에 kakao 로 들어온 세션이 없습니다. 메시지 링크의 utm_source 가 kakao 인지 확인하세요.</p> : (
            <div className="b2b-table-wrap"><table className="b2b-table">
              <thead><tr><th>매체(utm_medium)</th><th className="num">세션</th><th className="num">구매</th><th className="num">구매전환율</th><th className="num">매출</th></tr></thead>
              <tbody>{data.ga.map((g) => (
                <tr key={g.medium}><td>{g.medium}</td><td className="num">{qty(g.sessions)}</td><td className="num">{qty(g.purchases)}</td><td className="num">{pct(g.purchases, g.sessions)}</td><td className="num">{wonText(g.revenue)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>GA 는 어제까지 확정값이고 하루쯤 늦게 잡힙니다. 매체 이름은 utm 규칙(메시지종류-경로)대로 나옵니다.</p>
        </section>
      </div>

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">최근 12주 발송 추이</span></div>
        <TrendChart data={trendData} />
      </section>

      {!!data?.rows.length && (
        <section className="b2b-card" style={{ marginTop: 14 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">이 주의 기록</span><span className="sm-faint" style={{ fontSize: 12, marginLeft: "auto" }}>{qtyText(data.rows.length, "줄")}</span></div>
          <div className="b2b-table-wrap"><table className="b2b-table">
            <thead><tr><th>날짜</th><th>수단</th><th>템플릿·캠페인</th><th className="num">발송</th><th className="num">클릭</th><th>메모</th><th>출처</th><th /></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>{r.date}{r.grain === "week" ? " 주" : ""}</td>
                <td>{defs.find((d) => d.key === r.source)?.label || r.source}</td>
                <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.template}>{r.template || "-"}</td>
                <td className="num">{qty(r.sent)}</td>
                <td className="num">{r.clicked == null ? "-" : qty(r.clicked)}</td>
                <td className="sm-faint" style={{ fontSize: 12 }}>{r.note || ""}</td>
                <td className="sm-faint" style={{ fontSize: 12 }}>{r.batch === "solapi-sync" ? "솔라피 API" : r.batch === "manual" ? "직접 입력" : r.batch || "-"}</td>
                <td><button className="b2b-link-btn" onClick={() => remove(r.id)} style={{ color: "var(--sm-danger)", fontSize: 12 }}>삭제</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}
