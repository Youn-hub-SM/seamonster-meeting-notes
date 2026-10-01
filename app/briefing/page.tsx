"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ComboBarLine, PIE_COLORS, moneyCompact } from "@/app/components/charts";

// 종합 리포트(2026-09-30, 메뉴 기타) — 매출·광고 분석 에이전트(app/lib/analyst.ts, 주간·월간은 analyst-period.ts)의 리포트.
//  일일·주간·월간 탭. 로그인한 모두가 보고 만들고 보낸다.
//  흐름: 담당자가 매출 업로드 → 안내 창 '… 종합 리포트 생성'(?period=&date=&run=1) → 여기서 자동 분석 → 확인 후 [팀즈로 보내기].
//  (매출 › 리포트의 '일일 매출 리포트'·'주간 매출 리포트'(메일)와 별개)
//  14:30(운영) — 매출이 다 들어왔는데 아직 발송 전이면 자동 생성·발송(일일 매일, 주간 월~수, 월간 1~5일). 06:30 업무 브리핑은 중단.
//  [다시 분석](매출이 그대로여도 새로)과 하단 설정은 관리자만 — 서버가 판정한다(/api/analyst, /api/briefing/settings).

type AnalystUsage = { input: number; cache_read: number; cache_write: number; output: number; iterations: number; tool_calls: number; est_usd: number };
type TrendPts = { title: string; summary: string; points: { b: string; spend?: number; cost?: number; roas?: number | null; roas_all?: number | null }[] } | null;
type AnalystReport = { report_date: string; status: string; running?: boolean; sent_current?: boolean; trend_meta?: TrendPts; trend_naver?: TrendPts; sales_ready: boolean; report_md: string | null; model: string | null; usage: AnalystUsage | null; trigger: string | null; error: string | null; sent_at: string | null; created_at: string; updated_at: string };
const kstYesterday = () => new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
const TRIGGER_LABEL: Record<string, string> = { manual: "생성", cron: "자동 발송", upload: "매출 업로드 직후", rerun: "매출 변경 재분석" };
const SKIP_MSG: Record<string, string> = {
  "이미 분석됨": "매출이 그대로라 기존 리포트를 유지합니다.",
  "매출 업로드 대기": "매출이 아직 없어 기존 리포트를 유지합니다.",
  "분석 진행 중": "분석이 진행 중입니다. 잠시 뒤 새로고침하세요.",
};

const dtKst = (iso: string) => {
  try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
  catch { return iso.slice(0, 16).replace("T", " "); }
};

// 광고 추이 그래프를 끼울 줄 — '### 광고 추이' 아래 요약 줄(-) 다음, 추이 표 앞. 그 제목이 없으면(옛 리포트)
//  '## (2.) 광고' 섹션 끝(다음 ## 앞 또는 맨 끝). 광고 섹션도 없으면 -1(그래프는 리포트 아래 카드로).
function trendSlotAt(lines: string[]): number {
  const h = lines.findIndex((l) => /^###\s*광고 추이/.test(l.trim()));
  if (h >= 0) {
    let i = h + 1;
    while (i < lines.length && (/^-\s/.test(lines[i].trim()) || !lines[i].trim())) i++;
    return i;
  }
  const a = lines.findIndex((l) => /^##\s*(\d+\.\s*)?광고/.test(l.trim()));
  if (a < 0) return -1;
  const e = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim()));
  return e < 0 ? lines.length : e;
}

// 브리핑 마크다운 렌더 — 회의정리 렌더 패턴 + 표(| … |) 지원(소진 임박 표 등)
//  slot(광고 추이 그래프)은 광고 섹션 안(trendSlotAt)에 끼운다 — 읽는 흐름이 매출 → 광고 → 재고 → 원인 → 확인으로 이어지게.
function renderBriefMd(md: string, slot?: ReactNode): { node: ReactNode; placed: boolean } {
  const bold = (txt: string) => txt.split(/\*\*(.+?)\*\*/g).map((seg, k) => (k % 2 ? <strong key={k}>{seg}</strong> : seg));
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  const slotAt = slot ? trendSlotAt(lines) : -1;
  for (let i = 0; i < lines.length; i++) {
    if (i === slotAt) out.push(<div key="trend-slot" style={{ margin: "8px 0 4px" }}>{slot}</div>);
    const t = lines[i].trim();
    // 연속된 | 행 → 표 (구분선 |---| 은 건너뜀)
    if (/^\|.*\|$/.test(t)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const raw = lines[i].trim();
        if (!/^\|[\s|:-]+\|$/.test(raw)) rows.push(raw.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      if (rows.length) {
        const [head, ...body] = rows;
        out.push(
          <div key={`tbl${i}`} className="b2b-table-wrap" style={{ margin: "6px 0 10px" }}>
            <table className="b2b-table" style={{ fontSize: 14 }}>
              <thead><tr>{head.map((c, k) => <th key={k} className={k > 0 ? "num" : undefined}>{c}</th>)}</tr></thead>
              <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, k) => <td key={k} className={k > 0 ? "num" : undefined}>{bold(c)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      }
      continue;
    }
    if (!t) { out.push(<div key={i} style={{ height: 10 }} />); continue; }
    if (t === "---") { out.push(<hr key={i} style={{ border: "none", borderTop: "1px solid var(--sm-border)", margin: "14px 0" }} />); continue; }
    if (/^##\s/.test(t)) { out.push(<div key={i} style={{ fontSize: 18, fontWeight: 800, marginTop: 16, marginBottom: 6 }}>{t.replace(/^##\s*/, "")}</div>); continue; }
    if (/^###\s/.test(t)) { out.push(<div key={i} style={{ fontSize: 16, fontWeight: 700, marginTop: 10, marginBottom: 4 }}>{t.replace(/^###\s*/, "")}</div>); continue; }
    if (/^-\s/.test(t)) { out.push(<div key={i} style={{ paddingLeft: 18, textIndent: -12 }}>{"· "}{bold(t.replace(/^-\s*/, ""))}</div>); continue; }
    out.push(<div key={i}>{bold(t)}</div>);
  }
  if (slotAt === lines.length) out.push(<div key="trend-slot" style={{ margin: "8px 0 4px" }}>{slot}</div>);
  return { node: <div style={{ fontSize: 15, lineHeight: 1.8 }}>{out}</div>, placed: slotAt >= 0 };
}

// 광고 추이 그래프(메타·네이버) — 리포트 안에 끼울 땐 요약 줄이 바로 위에 있으므로 summary 를 다시 쓰지 않는다
function trendCharts(report: AnalystReport | null, showSummary: boolean): ReactNode {
  const items = [
    { t: report?.trend_meta, name: "메타", bar: "지출", line: "ROAS", val: (p: NonNullable<TrendPts>["points"][number]) => [p.spend || 0, p.roas] as const },
    { t: report?.trend_naver, name: "네이버", bar: "광고비", line: "전환 ROAS", val: (p: NonNullable<TrendPts>["points"][number]) => [p.cost || 0, p.roas_all] as const },
  ].filter((x) => x.t?.points?.length);
  if (!items.length) return null;
  return items.map((x) => (
    <div key={x.name} style={{ marginBottom: 18 }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{x.name} — {x.bar}(막대) · {x.line}(선)</div>
      {showSummary && x.t?.summary && <div className="sm-faint" style={{ fontSize: 12, marginBottom: 6 }}>{x.t.summary}</div>}
      <ComboBarLine
        periods={x.t!.points.map((p) => p.b)}
        barSeries={[{ key: x.bar, values: x.t!.points.map((p) => x.val(p)[0]) }]}
        barColors={[PIE_COLORS[0]]}
        lineValues={x.t!.points.map((p) => { const v = x.val(p)[1]; return v == null ? null : Math.round(v * 100); })}
        lineLabel={x.line} lineFmt={(n) => `${n}%`} lineUnit=""
        barFmt={moneyCompact} barUnit="원"
      />
    </div>
  ));
}

type Period = "daily" | "weekly" | "monthly";
const TABS: { key: Period; label: string }[] = [{ key: "daily", label: "일일" }, { key: "weekly", label: "주간" }, { key: "monthly", label: "월간" }];
// 기간 고르기(KST) — 주간·월간은 끝난 기간만 최근 12개
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shiftD = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (ymd: string) => shiftD(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const mdS = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const recentWeeks = () => { const last = shiftD(mondayOf(kstToday()), -7); return Array.from({ length: 12 }, (_, k) => { const s = shiftD(last, -7 * k); return { value: s, label: `${mdS(s)}~${mdS(shiftD(s, 6))}` }; }); };
const recentMonths = () => Array.from({ length: 12 }, (_, k) => {
  const d = new Date(`${kstToday().slice(0, 8)}01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1 - k);
  const s = d.toISOString().slice(0, 10); return { value: s, label: `${s.slice(0, 4)}년 ${Number(s.slice(5, 7))}월` };
});
const defaultKey = (p: Period) => (p === "weekly" ? recentWeeks()[0].value : p === "monthly" ? recentMonths()[0].value : kstYesterday());

export default function SummaryReportPage() {
  const [period, setPeriod] = useState<Period>("daily");
  const [date, setDate] = useState(kstYesterday()); // 기간 키(일일 = 그날, 주간 = 월요일, 월간 = 1일)
  const [label, setLabel] = useState("");
  const [ready, setReady] = useState(false); // 주소(?period·?date·?run) 읽은 뒤에 불러온다
  const [report, setReport] = useState<AnalystReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState<"" | "run" | "send">("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const autoRun = useRef(false); // 매출 업로드 안내 창에서 넘어오면(?run=1) 한 번 자동 분석
  const viewRef = useRef(`${period}:${date}`); // 늦게 도착한 다른 기간 응답은 버린다
  useEffect(() => { viewRef.current = `${period}:${date}`; }, [period, date]);
  // 설정(관리자) — 로드 성공 전에는 저장을 막는다(기존 웹훅이 빈 값으로 덮이지 않게)
  const [webhook, setWebhook] = useState("");
  const [analystAuto, setAnalystAuto] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState("");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const p = sp.get("period");
    const per: Period = p === "weekly" || p === "monthly" ? p : "daily";
    const d = sp.get("date");
    setPeriod(per);
    setDate(d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : defaultKey(per));
    if (sp.get("run") === "1") {
      autoRun.current = true;
      window.history.replaceState(null, "", `${window.location.pathname}?period=${per}${d ? `&date=${d}` : ""}`); // 새로고침 때 다시 돌지 않게
    }
    setReady(true);
  }, []);

  // 오류는 지우지 않는다(발송 실패 메시지가 다시 불러오기에 가려지지 않게) — 지우는 건 기간 변경·새 실행 때
  const load = useCallback(async (p: Period, d: string): Promise<AnalystReport | null> => {
    const key = `${p}:${d}`;
    const stale = () => key !== viewRef.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/analyst?period=${p}&date=${d}`, { cache: "no-store" });
      const j = await r.json();
      if (stale()) return null;
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setReport(j.report || null);
      setPending(typeof j.pending_migration === "string" ? j.pending_migration : j.pending_migration ? "마이그레이션" : "");
      setAdmin(!!j.admin);
      setLabel(j.label || "");
      return j.report || null;
    } catch (e) { if (!stale()) setError(e instanceof Error ? e.message : "조회 오류"); return null; }
    finally { if (!stale()) setLoading(false); }
  }, []);

  // 분석 — force(매출이 그대로여도 새로)는 관리자만 서버가 받아 준다
  const run = useCallback(async (p: Period, d: string, force: boolean) => {
    setBusy("run"); setError(""); setInfo("");
    try {
      const r = await fetch("/api/analyst", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: p, date: d, force, send: false }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || (r.status === 504 ? "시간이 초과됐습니다 — 잠시 뒤 다시 시도하세요." : "분석 실패"));
      if (j.skipped) setInfo(p !== "daily" && j.skipped === "매출 업로드 대기" ? "마지막 날 매출이 아직 없어 기존 리포트를 유지합니다." : SKIP_MSG[j.skipped] || j.skipped);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    await load(p, d); // 실패해도 최신 상태(진행 중·이전 리포트)를 다시 보여 준다
    setBusy("");
  }, [load]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    (async () => {
      let rep = await load(period, date);
      if (!autoRun.current) return;
      autoRun.current = false;
      // 다른 분석이 돌고 있으면 끝날 때까지 기다렸다가(최대 6분) 한 번 — 그 사이 올린 매출까지 반영되게. 매출이 그대로면 서버가 건너뛴다.
      for (let i = 0; alive && rep?.running && i < 36; i++) { await new Promise((r) => setTimeout(r, 10_000)); if (!alive) break; rep = await load(period, date); }
      if (alive && !rep?.running) await run(period, date, false);
    })();
    return () => { alive = false; };
  }, [ready, period, date, load, run]);

  async function send() {
    if (report?.sent_current && report.sent_at && !window.confirm(`이미 ${dtKst(report.sent_at)}에 팀즈로 보냈습니다. 다시 보낼까요?`)) return;
    setBusy("send"); setError(""); setInfo("");
    try {
      const r = await fetch("/api/analyst", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, date, send: true }),
      });
      const j = await r.json().catch(() => null);
      if (j?.sent && !j.sent.ok) throw new Error(`팀즈 발송 실패: ${j.sent.error}`);
      if (!r.ok || !j?.ok) throw new Error(j?.error || "발송 실패");
      if (j.sent?.ok) setInfo("팀즈로 보냈습니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "발송 실패"); }
    await load(period, date);
    setBusy("");
  }

  useEffect(() => {
    if (!admin) return;
    (async () => {
      try {
        const j = await (await fetch("/api/briefing/settings", { cache: "no-store" })).json();
        if (j.ok) { setWebhook(j.webhook || ""); setAnalystAuto(j.analystAuto !== false); setSettingsLoaded(true); }
      } catch { /* 로드 실패 시 저장 버튼 비활성 유지 */ }
    })();
  }, [admin]);

  async function saveSettings() {
    setSettingsMsg("");
    try {
      const r = await fetch("/api/briefing/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhook, analystAuto }),
      });
      const j = await r.json().catch(() => null);
      setSettingsMsg(r.ok && j?.ok ? "저장됐습니다." : `저장 실패: ${j?.error || "서버 오류"}`);
    } catch { setSettingsMsg("저장 실패: 네트워크 오류"); }
  }

  const switchTo = (p: Period) => { if (p === period || busy !== "") return; setPeriod(p); setDate(defaultKey(p)); setReport(null); setError(""); setInfo(""); };
  const pickDate = (d: string) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { setDate(d); setError(""); setInfo(""); } };
  const hasReport = !!report?.report_md;
  const charts = hasReport ? trendCharts(report, false) : null;
  const briefMd = hasReport ? renderBriefMd(report?.report_md || "", charts ?? undefined) : null;
  const unsent = hasReport && !report?.sent_current && !report?.running; // 지금 버전을 아직 안 보냈다(보낸 뒤 다시 분석한 경우 포함)
  const options = period === "weekly" ? recentWeeks() : period === "monthly" ? recentMonths() : [];

  return (
    // 본문이 좌측에 쏠리지 않게 중앙 정렬(가독 폭 960)
    <div className="b2b-container" style={{ maxWidth: 960, margin: "0 auto" }}>
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">종합 리포트</h1></div>
        <div className="b2b-page-actions">
          {period === "daily" ? (
            <input type="date" className="b2b-input" style={{ width: "auto" }} value={date} max={kstYesterday()} disabled={busy !== ""} onChange={(e) => pickDate(e.target.value)} />
          ) : (
            <select className="b2b-input" style={{ width: "auto" }} value={date} disabled={busy !== ""} onChange={(e) => pickDate(e.target.value)}>
              {!options.some((o) => o.value === date) && <option value={date}>{label || date}</option>}
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <button className={hasReport ? "b2b-btn-secondary" : "b2b-btn-primary"} onClick={() => run(period, date, admin)} disabled={busy !== "" || loading || !!report?.running}>
            {busy === "run" ? "분석 중... (1~4분)" : hasReport ? "다시 분석" : "분석하기"}
          </button>
          <button className={hasReport ? "b2b-btn-primary" : "b2b-btn-secondary"} onClick={send} disabled={busy !== "" || loading || !hasReport || !!report?.running}>
            {busy === "send" ? "보내는 중..." : "팀즈로 보내기"}
          </button>
        </div>
      </header>

      <div className="sm-tabbar" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`sm-tab ${period === t.key ? "is-active" : ""}`} onClick={() => switchTo(t.key)} disabled={busy !== ""}>{t.label}</button>
        ))}
      </div>

      {pending && <div className="sm-warn" style={{ marginBottom: 12 }}>리포트 보관에는 마이그레이션 <code>{pending}</code> 적용이 필요합니다.</div>}
      {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}
      {info && <div className="sm-success" style={{ marginBottom: 12 }}>{info}</div>}
      {report?.running && busy !== "run" && <div className="sm-warn" style={{ marginBottom: 12 }}>분석이 진행 중입니다. 잠시 뒤 새로고침하세요.</div>}
      {unsent && busy === "" && <div className="sm-warn" style={{ marginBottom: 12 }}>{report?.sent_at ? "보낸 뒤 다시 분석했습니다." : "아직 발송 전입니다."} 확인 후 [팀즈로 보내기]를 누르세요.</div>}
      {hasReport && report?.error && <div className="sm-warn" style={{ marginBottom: 12 }}>{report.error} — 아래는 이전 리포트입니다.</div>}

      {loading && !report ? <div className="b2b-loading">불러오는 중...</div> : !report || (report.status === "running" && !hasReport) ? (
        <div className="b2b-empty">아직 이 기간의 종합 리포트가 없습니다.</div>
      ) : (
        <section className="b2b-card">
          <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>
            {label || report.report_date} · {report.sales_ready ? "매출 반영" : period === "daily" ? "매출 없음(광고만)" : "마지막 날 매출 미반영"} · {TRIGGER_LABEL[report.trigger || ""] || report.trigger || ""} {dtKst(report.updated_at)}
            {report.sent_at ? ` · 팀즈 발송 ${dtKst(report.sent_at)}${report.sent_current ? "" : "(이전 버전)"}` : " · 발송 전"}
            {admin && report.model ? ` · ${report.model}` : ""}
            {admin && report.usage ? ` · 조회 ${report.usage.tool_calls}회 · 약 $${report.usage.est_usd}` : ""}
          </div>
          {hasReport ? briefMd?.node : (
            <div className="sm-warn">분석에 실패했습니다{report.error ? `: ${report.error}` : ""} — [분석하기]를 다시 눌러 주세요.</div>
          )}
        </section>
      )}

      {hasReport && charts && !briefMd?.placed ? (
        <section className="b2b-card" style={{ marginTop: 14 }}>
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">광고 추이 · {report?.trend_meta?.title || report?.trend_naver?.title}</h2>
          </div>
          {trendCharts(report, true)}
        </section>
      ) : null}

      {admin && (
        <section className="b2b-card" style={{ marginTop: 28 }}>
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">리포트 설정</h2>
          </div>
          <label className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input type="checkbox" checked={analystAuto} onChange={(e) => setAnalystAuto(e.target.checked)} />
            <span>자동 발송 (매출이 있고 발송 전일 때 · 일일 매일 14:30, 주간 월~수 14:35, 월간 1~5일 14:40)</span>
          </label>
          <label className="b2b-field" style={{ maxWidth: 640, marginBottom: 12 }}>
            <span className="b2b-field-label">팀즈 웹훅 URL</span>
            <input className="b2b-input" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://..." />
          </label>
          <div className="sm-row" style={{ gap: 10, alignItems: "center" }}>
            <button className="b2b-btn-primary" onClick={saveSettings} disabled={!settingsLoaded}>설정 저장</button>
            {settingsMsg && <span className="sm-faint" style={{ fontSize: 12 }}>{settingsMsg}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
