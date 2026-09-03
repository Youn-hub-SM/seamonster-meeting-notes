"use client";

import { useCallback, useEffect, useState } from "react";

// 대표 전용 아침 브리핑 — 업무도우미 전 영역의 어제 변화 + AI 인사이트.
//  매일 06:30(운영) 자동 생성되고, 여기서 언제든 다시 생성/팀즈 발송할 수 있다.

type Briefing = { brief_date: string; insight: string | null; data: Record<string, unknown>; model: string | null; created_at: string };

const dtKst = (iso: string) => {
  try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
  catch { return iso.slice(0, 16).replace("T", " "); }
};

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export default function BriefingPage() {
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

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/briefing/settings", { cache: "no-store" })).json();
        if (j.ok) { setAuto(!!j.auto); setWebhook(j.webhook || ""); setSettingsLoaded(true); }
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
        body: JSON.stringify({ auto, webhook }),
      });
      const j = await r.json().catch(() => null);
      setSettingsMsg(r.ok && j?.ok ? "저장됐습니다." : `저장 실패: ${j?.error || "서버 오류"}`);
    } catch { setSettingsMsg("저장 실패: 네트워크 오류"); }
  }

  const md = brief?.insight || "";

  if (forbidden) {
    return (
      <div className="b2b-container">
        <header className="b2b-page-head"><div><h1 className="b2b-page-title">아침 브리핑</h1></div></header>
        <div className="b2b-error">대표 전용 화면입니다.</div>
      </div>
    );
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">아침 브리핑</h1></div>
        <div className="b2b-page-actions">
          <select className="b2b-input" style={{ width: "auto" }} value={date} onChange={(e) => setDate(e.target.value)}>
            {date && !recent.includes(date) && <option value={date}>{date}</option>}
            {recent.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button className="b2b-btn-secondary" onClick={() => generate(true)} disabled={busy || loading}>팀즈로 보내기</button>
          <button className="b2b-btn-primary" onClick={() => generate(false)} disabled={busy || loading}>
            {busy ? "생성 중..." : brief ? "다시 생성" : "브리핑 생성"}
          </button>
        </div>
      </header>

      {pendingMigration && (
        <div className="sm-warn" style={{ marginBottom: 12 }}>
          브리핑 보관에는 마이그레이션 <code>103_briefings.sql</code> 적용이 필요합니다. 자동 생성(06:30) 크론도 그 파일에 함께 들어 있습니다.
        </div>
      )}
      {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : !brief ? (
        <div className="b2b-empty">
          아직 이 날짜의 브리핑이 없습니다. [브리핑 생성]을 누르면 어제까지의 변화를 집계해 만듭니다.
          <br /><span className="sm-faint" style={{ fontSize: 12 }}>운영 서버에서는 매일 06:30 에 자동 생성됩니다(아래 설정에서 켜고 끔).</span>
        </div>
      ) : (
        <section className="b2b-card" style={{ maxWidth: 860 }}>
          <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>
            {brief.brief_date} · 생성 {dtKst(brief.created_at)}{brief.model ? ` · ${brief.model}` : ""}
            {date !== kstToday() && <span style={{ marginLeft: 8 }}>· 과거 날짜를 [다시 생성]하면 발송예정·대기 같은 상태 지표는 지금 기준으로 계산됩니다</span>}
          </div>
          {md ? (
            <div style={{ fontSize: 15, lineHeight: 1.8 }}>
              {md.split("\n").map((line, i) => {
                const t = line.trim();
                if (!t) return <div key={i} style={{ height: 10 }} />;
                if (t === "---") return <hr key={i} style={{ border: "none", borderTop: "1px solid var(--sm-border)", margin: "14px 0" }} />;
                const bold = (txt: string) => txt.split(/\*\*(.+?)\*\*/g).map((seg, k) => (k % 2 ? <strong key={k}>{seg}</strong> : seg));
                if (/^##\s/.test(t)) return <div key={i} style={{ fontSize: 18, fontWeight: 800, marginTop: 16, marginBottom: 6 }}>{t.replace(/^##\s*/, "")}</div>;
                if (/^###\s/.test(t)) return <div key={i} style={{ fontSize: 16, fontWeight: 700, marginTop: 10, marginBottom: 4 }}>{t.replace(/^###\s*/, "")}</div>;
                if (/^-\s/.test(t)) return <div key={i} style={{ paddingLeft: 18, textIndent: -12 }}>{"· "}{bold(t.replace(/^-\s*/, ""))}</div>;
                return <div key={i}>{bold(t)}</div>;
              })}
            </div>
          ) : (
            <div className="sm-warn">집계는 저장됐지만 AI 인사이트 생성이 실패했습니다 — [다시 생성]을 눌러 주세요.</div>
          )}
        </section>
      )}

      <section className="b2b-card" style={{ marginTop: 28, maxWidth: 860 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">브리핑 설정 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 대표 전용</span></h2>
        </div>
        <label className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 10 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>매일 06:30 자동 생성 (끄면 AI 호출 없음 — 수동 [브리핑 생성]만)</span>
        </label>
        <label className="b2b-field" style={{ maxWidth: 640 }}>
          <span className="b2b-field-label">팀즈 웹훅 URL <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 — 비우면 이 화면에서만 확인)</span></span>
          <input className="b2b-input" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://..." />
        </label>
        <p className="sm-faint" style={{ fontSize: 12, margin: "6px 0 10px", lineHeight: 1.6 }}>
          비공개 채널(예: 나만 있는 '대표 브리핑' 채널)에서 Workflows 앱의 "웹후크 요청을 받으면 채널에 게시"를 만들고 그 URL을 붙여 넣으세요 —
          기존 B2B 알림 채널과 같은 방식입니다. 등록하면 자동 생성 직후와 [팀즈로 보내기]에서 발송됩니다.
        </p>
        <div className="sm-row" style={{ gap: 10, alignItems: "center" }}>
          <button className="b2b-btn-primary" onClick={saveSettings} disabled={!settingsLoaded}>설정 저장</button>
          {settingsMsg && <span className="sm-faint" style={{ fontSize: 12 }}>{settingsMsg}</span>}
        </div>
      </section>
    </div>
  );
}
