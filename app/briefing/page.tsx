"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

// 대표 전용 일일 업무도우미 리포트 v2 — 어제 있었던 일 + 오늘 체크할 것.
//  매일 06:30(운영) 자동 생성되고, 여기서 언제든 다시 생성/팀즈 발송할 수 있다.
//  '어제 분석' 탭(2026-09-30) — 어제 매출·광고 분석 에이전트(app/lib/analyst.ts): 매출 업로드 직후 자동, 없으면 14:30.

type Briefing = { brief_date: string; insight: string | null; data: Record<string, unknown>; model: string | null; created_at: string };
type AnalystUsage = { input: number; cache_read: number; cache_write: number; output: number; iterations: number; tool_calls: number; est_usd: number };
type AnalystReport = { report_date: string; status: string; running?: boolean; sales_ready: boolean; report_md: string | null; model: string | null; usage: AnalystUsage | null; trigger: string | null; error: string | null; sent_at: string | null; created_at: string; updated_at: string };
const kstYesterday = () => new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
const TRIGGER_LABEL: Record<string, string> = { upload: "매출 업로드 직후", cron: "14:30 예약", manual: "수동", rerun: "매출 변경 재분석" };

const dtKst = (iso: string) => {
  try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
  catch { return iso.slice(0, 16).replace("T", " "); }
};

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// 브리핑 마크다운 렌더 — 회의정리 렌더 패턴 + 표(| … |) 지원(소진 임박 표 등)
function renderBriefMd(md: string) {
  const bold = (txt: string) => txt.split(/\*\*(.+?)\*\*/g).map((seg, k) => (k % 2 ? <strong key={k}>{seg}</strong> : seg));
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
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
  return <div style={{ fontSize: 15, lineHeight: 1.8 }}>{out}</div>;
}

export default function BriefingPage() {
  const [view, setView] = useState<"brief" | "analyst">("brief");
  const [date, setDate] = useState(kstToday());
  const [brief, setBrief] = useState<Briefing | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false); // 관리자(대표) 아님 — 셸도 숨긴다
  const [pendingMigration, setPendingMigration] = useState(false);
  // 설정(자동 생성·팀즈 웹훅) — 로드 성공 전에는 저장을 막는다(기존 웹훅이 빈 값으로 덮이지 않게)
  const [auto, setAuto] = useState(true);
  const [webhook, setWebhook] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState("");
  const [analystAuto, setAnalystAuto] = useState(true);
  // 어제 분석
  const [aDate, setADate] = useState(kstYesterday());
  const [aReport, setAReport] = useState<AnalystReport | null>(null);
  const [aRecent, setARecent] = useState<string[]>([]);
  const [aLoading, setALoading] = useState(false);
  const [aPending, setAPending] = useState(false);
  const [aBusy, setABusy] = useState(false); // 일일 리포트 탭과 따로 — 분석(1~3분) 중에도 다른 탭은 그대로
  const [aError, setAError] = useState("");

  const load = useCallback(async (d: string) => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/briefing?date=${d}`, { cache: "no-store" });
      const j = await r.json();
      if (r.status === 403) { setForbidden(true); return; }
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setBrief(j.briefing || null);
      setRecent(j.recent || []);
      setPendingMigration(!!j.pending_migration);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(date); }, [load, date]);

  // 오류는 지우지 않는다(발송 실패 메시지가 다시 불러오기에 가려지지 않게) — 지우는 건 날짜 변경·새 실행 때
  const loadAnalyst = useCallback(async (d: string) => {
    setALoading(true);
    try {
      const r = await fetch(`/api/analyst?date=${d}`, { cache: "no-store" });
      const j = await r.json();
      if (r.status === 403) { setForbidden(true); return; }
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setAReport(j.report || null);
      setARecent(j.recent || []);
      setAPending(!!j.pending_migration);
    } catch (e) { setAError(e instanceof Error ? e.message : "조회 오류"); }
    setALoading(false);
  }, []);
  useEffect(() => { if (view === "analyst") loadAnalyst(aDate); }, [view, aDate, loadAnalyst]);

  // send=true 는 기존 분석을 다시 돌리지 않고 보낸다(없을 때만 분석) — 불필요한 AI 호출 방지
  async function runAnalyst(send: boolean) {
    setABusy(true); setAError("");
    try {
      const r = await fetch("/api/analyst", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: aDate, force: !send, send }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || (r.status === 504 ? "시간이 초과됐습니다 — 잠시 뒤 다시 시도하세요." : "분석 실패"));
      if (j.sent && !j.sent.ok) setAError(`팀즈 발송 실패: ${j.sent.error}`);
    } catch (e) { setAError(e instanceof Error ? e.message : "분석 실패"); }
    await loadAnalyst(aDate); // 실패해도 최신 상태(진행 중·이전 보고서)를 다시 보여 준다
    setABusy(false);
  }

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/briefing/settings", { cache: "no-store" })).json();
        if (j.ok) { setAuto(!!j.auto); setWebhook(j.webhook || ""); setAnalystAuto(j.analystAuto !== false); setSettingsLoaded(true); }
      } catch { /* 로드 실패 시 저장 버튼 비활성 유지 */ }
    })();
  }, []);

  // send=true(팀즈로 보내기)는 재생성 없이 기존 본문을 보낸다(없을 때만 생성) — 불필요한 AI 호출 방지.
  async function generate(send: boolean) {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/briefing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, force: !send, send }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || "생성 실패");
      if (send && j.sent && !j.sent.ok) setError(`팀즈 발송 실패: ${j.sent.error}`);
      await load(date);
    } catch (e) { setError(e instanceof Error ? e.message : "생성 실패"); }
    setBusy(false);
  }

  async function saveSettings() {
    setSettingsMsg("");
    try {
      const r = await fetch("/api/briefing/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto, webhook, analystAuto }),
      });
      const j = await r.json().catch(() => null);
      setSettingsMsg(r.ok && j?.ok ? "저장됐습니다." : `저장 실패: ${j?.error || "서버 오류"}`);
    } catch { setSettingsMsg("저장 실패: 네트워크 오류"); }
  }

  const md = brief?.insight || "";

  if (forbidden) {
    return (
      <div className="b2b-container" style={{ maxWidth: 960, margin: "0 auto" }}>
        <header className="b2b-page-head"><div><h1 className="b2b-page-title">일일 리포트</h1></div></header>
        <div className="b2b-error">대표 전용 화면입니다.</div>
      </div>
    );
  }

  return (
    // 본문이 좌측에 쏠리지 않게 중앙 정렬(가독 폭 960)
    <div className="b2b-container" style={{ maxWidth: 960, margin: "0 auto" }}>
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">일일 리포트</h1></div>
        {view === "brief" ? (
          <div className="b2b-page-actions">
            <select className="b2b-input" style={{ width: "auto" }} value={date} onChange={(e) => setDate(e.target.value)}>
              {date && !recent.includes(date) && <option value={date}>{date}</option>}
              {recent.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="b2b-btn-secondary" onClick={() => generate(true)} disabled={busy || loading}>팀즈로 보내기</button>
            <button className="b2b-btn-primary" onClick={() => generate(false)} disabled={busy || loading}>
              {busy ? "생성 중..." : brief ? "다시 생성" : "리포트 생성"}
            </button>
          </div>
        ) : (
          <div className="b2b-page-actions">
            <select className="b2b-input" style={{ width: "auto" }} value={aDate} disabled={aBusy} onChange={(e) => { setADate(e.target.value); setAError(""); }}>
              {aDate && !aRecent.includes(aDate) && <option value={aDate}>{aDate}</option>}
              {aRecent.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="b2b-btn-secondary" onClick={() => runAnalyst(true)} disabled={aBusy || aLoading}>팀즈로 보내기</button>
            <button className="b2b-btn-primary" onClick={() => runAnalyst(false)} disabled={aBusy || aLoading || !!aReport?.running}>
              {aBusy ? "분석 중... (1~3분)" : aReport?.report_md ? "다시 분석" : "분석하기"}
            </button>
          </div>
        )}
      </header>

      <div className="sm-tabbar" style={{ marginBottom: 14 }}>
        <button type="button" className={`sm-tab ${view === "brief" ? "is-active" : ""}`} onClick={() => { setView("brief"); setError(""); }}>일일 리포트</button>
        <button type="button" className={`sm-tab ${view === "analyst" ? "is-active" : ""}`} onClick={() => { setView("analyst"); setError(""); }}>어제 분석</button>
      </div>

      {view === "analyst" && (
        <>
          {aPending && <div className="sm-warn" style={{ marginBottom: 12 }}>어제 분석 보관에는 마이그레이션 <code>122_analyst_reports.sql</code> 적용이 필요합니다. 14:30 예약 실행도 그 파일에 함께 들어 있습니다.</div>}
          {aError && <div className="b2b-error" style={{ marginBottom: 12 }}>{aError}</div>}
          {aReport?.running && !aBusy && <div className="sm-warn" style={{ marginBottom: 12 }}>분석이 진행 중입니다. 잠시 뒤 새로고침하세요.</div>}
          {aReport?.report_md && aReport.error && <div className="sm-warn" style={{ marginBottom: 12 }}>{aReport.error} — 아래는 이전 분석입니다.</div>}
          {aLoading ? <div className="b2b-loading">불러오는 중...</div> : !aReport || (aReport.status === "running" && !aReport.report_md) ? (
            <div className="b2b-empty">아직 이 날짜의 분석이 없습니다.</div>
          ) : (
            <section className="b2b-card">
              <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>
                분석일 {aReport.report_date} · {aReport.sales_ready ? "매출 반영" : "매출 미업로드(광고만)"} · {TRIGGER_LABEL[aReport.trigger || ""] || aReport.trigger || ""} {dtKst(aReport.updated_at)}
                {aReport.model ? ` · ${aReport.model}` : ""}
                {aReport.usage ? ` · 도구 ${aReport.usage.tool_calls}회 · 약 $${aReport.usage.est_usd}` : ""}
                {aReport.sent_at ? ` · 팀즈 발송 ${dtKst(aReport.sent_at)}` : ""}
              </div>
              {aReport.report_md ? renderBriefMd(aReport.report_md) : (
                <div className="sm-warn">분석에 실패했습니다{aReport.error ? `: ${aReport.error}` : ""} — [다시 분석]을 눌러 주세요.</div>
              )}
            </section>
          )}
        </>
      )}

      {view === "brief" && pendingMigration && (
        <div className="sm-warn" style={{ marginBottom: 12 }}>
          리포트 보관에는 마이그레이션 <code>103_briefings.sql</code> 적용이 필요합니다. 자동 생성(06:30) 크론도 그 파일에 함께 들어 있습니다.
        </div>
      )}
      {view === "brief" && error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}

      {view !== "brief" ? null : loading ? <div className="b2b-loading">불러오는 중...</div> : !brief ? (
        <div className="b2b-empty">아직 이 날짜의 리포트가 없습니다.</div>
      ) : (
        <section className="b2b-card">
          <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>
            {brief.brief_date} · 생성 {dtKst(brief.created_at)}{brief.model ? ` · ${brief.model}` : ""}
            {date !== kstToday() && <span style={{ marginLeft: 8 }}>· 다시 생성 시 상태 지표는 지금 기준</span>}
          </div>
          {md ? renderBriefMd(md) : (
            <div className="sm-warn">집계는 저장됐지만 AI 인사이트 생성이 실패했습니다 — [다시 생성]을 눌러 주세요.</div>
          )}
        </section>
      )}

      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">리포트 설정</h2>
        </div>
        <label className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 10 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>매일 06:30 자동 생성</span>
        </label>
        <label className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 10 }}>
          <input type="checkbox" checked={analystAuto} onChange={(e) => setAnalystAuto(e.target.checked)} />
          <span>어제 분석 자동 실행 (매출 업로드 직후, 없으면 14:30)</span>
        </label>
        <label className="b2b-field" style={{ maxWidth: 640, marginBottom: 12 }}>
          <span className="b2b-field-label">팀즈 웹훅 URL <span className="sm-faint" style={{ fontWeight: 400 }}>(선택)</span></span>
          <input className="b2b-input" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://..." />
        </label>
        <div className="sm-row" style={{ gap: 10, alignItems: "center" }}>
          <button className="b2b-btn-primary" onClick={saveSettings} disabled={!settingsLoaded}>설정 저장</button>
          {settingsMsg && <span className="sm-faint" style={{ fontSize: 12 }}>{settingsMsg}</span>}
        </div>
      </section>
    </div>
  );
}
