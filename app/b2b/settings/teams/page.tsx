"use client";

import { useEffect, useState } from "react";
import { STATUS_SHORT } from "@/app/lib/b2b-orders";

// 설정 · Teams 연동 — 알림 관련 설정을 한 페이지로(2026-08-24 설정 재구성).
//  채널 웹훅(URL·켜기·테스트) + 아침 일정 알림 + 알림 이벤트 + [업무도우미 변경알림] 체크리스트.
//  구 B2B 도매 설정의 알림 카드들과 구 생산관리 설정의 변경알림 카드를 이관.

type EventMeta = {
  key: string;
  label: string;
  kind: "toggle" | "status";
  statuses?: string[];
};
type NotifyConfig = Record<string, boolean | string[]>;
type Msg = { ok: boolean; text: string };

function statusLabel(s: string): string {
  return (STATUS_SHORT as Record<string, string>)[s] ?? s;
}

export default function TeamsSettingsPage() {
  const [config, setConfig] = useState<NotifyConfig>({});
  const [events, setEvents] = useState<EventMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string>("");
  // 아침 일정 다이제스트
  const [digest, setDigest] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestMsg, setDigestMsg] = useState<Msg | null>(null);
  type DCfg = { enabled: boolean; hour: number; days: number; sections: { ship: boolean; unscheduled: boolean; invoice: boolean; payment: boolean }; title: string };
  const [dcfg, setDcfg] = useState<DCfg | null>(null);
  // Teams 알림(Workflows 웹훅) — URL 은 서버에 저장하고 브라우저엔 유무·꼬리만 보여준다
  const [teamsUrl, setTeamsUrl] = useState("");
  const [teamsHelperUrl, setTeamsHelperUrl] = useState("");
  const [teamsClaimsUrl, setTeamsClaimsUrl] = useState("");
  const [teamsInquiryUrl, setTeamsInquiryUrl] = useState("");
  const [teamsEnabled, setTeamsEnabled] = useState(false);
  const [teamsHasUrl, setTeamsHasUrl] = useState(false);
  const [teamsHasHelper, setTeamsHasHelper] = useState(false);
  const [teamsHasClaims, setTeamsHasClaims] = useState(false);
  const [teamsHasInquiry, setTeamsHasInquiry] = useState(false);
  const [teamsTail, setTeamsTail] = useState("");
  const [teamsHelperTail, setTeamsHelperTail] = useState("");
  const [teamsClaimsTail, setTeamsClaimsTail] = useState("");
  const [teamsInquiryTail, setTeamsInquiryTail] = useState("");
  const [teamsBusy, setTeamsBusy] = useState(false);
  const [teamsMsg, setTeamsMsg] = useState<Msg | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/b2b/settings/teams", { cache: "no-store" })).json();
        if (j.ok) {
          setTeamsEnabled(!!j.enabled); setTeamsHasUrl(!!j.hasUrl); setTeamsTail(j.urlTail || "");
          setTeamsHasHelper(!!j.hasHelperUrl); setTeamsHelperTail(j.helperTail || "");
          setTeamsHasClaims(!!j.hasClaimsUrl); setTeamsClaimsTail(j.claimsTail || "");
          setTeamsHasInquiry(!!j.hasInquiryUrl); setTeamsInquiryTail(j.inquiryTail || "");
        }
      } catch { /* 카드만 비활성 */ }
    })();
  }, []);
  async function saveTeams(nextEnabled?: boolean) {
    setTeamsBusy(true); setTeamsMsg(null);
    try {
      const j = await (await fetch("/api/b2b/settings/teams", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: teamsUrl, helperUrl: teamsHelperUrl, claimsUrl: teamsClaimsUrl, inquiryUrl: teamsInquiryUrl, enabled: nextEnabled ?? teamsEnabled }),
      })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setTeamsEnabled(!!j.enabled); setTeamsHasUrl(!!j.hasUrl); setTeamsHasHelper(!!j.hasHelperUrl); setTeamsHasClaims(!!j.hasClaimsUrl); setTeamsHasInquiry(!!j.hasInquiryUrl);
      setTeamsUrl(""); setTeamsHelperUrl(""); setTeamsClaimsUrl(""); setTeamsInquiryUrl("");
      const j2 = await (await fetch("/api/b2b/settings/teams", { cache: "no-store" })).json();
      if (j2.ok) { setTeamsTail(j2.urlTail || ""); setTeamsHelperTail(j2.helperTail || ""); setTeamsClaimsTail(j2.claimsTail || ""); setTeamsInquiryTail(j2.inquiryTail || ""); }
      setTeamsMsg({ ok: true, text: "저장했습니다." });
    } catch (e) { setTeamsMsg({ ok: false, text: e instanceof Error ? e.message : "저장 실패" }); }
    setTeamsBusy(false);
  }
  async function testTeams() {
    setTeamsBusy(true); setTeamsMsg(null);
    try {
      const j = await (await fetch("/api/b2b/settings/teams", { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error || "발송 실패");
      setTeamsMsg({ ok: true, text: `테스트 발송 완료 (${j.detail || "채널 확인"}).` });
    } catch (e) { setTeamsMsg({ ok: false, text: e instanceof Error ? e.message : "발송 실패" }); }
    setTeamsBusy(false);
  }
  // 발송 시각 목록(KST HH:MM)
  const [dtimes, setDtimes] = useState<string[]>(["06:00", "16:00"]);
  const [newTime, setNewTime] = useState("09:00");
  const [dcfgSaving, setDcfgSaving] = useState(false);
  const [digestLastSent, setDigestLastSent] = useState<string | null>(null); // 마지막 '자동' 발송일(크론 성공 시에만 기록)
  const [cronSecretSet, setCronSecretSet] = useState(true); // Vercel CRON_SECRET 유무(없으면 크론이 매일 401)

  // [업무도우미 변경알림] — 켜기 + 이벤트 체크리스트(발송은 Teams 변경알림 채널)
  type MnConfig = { enabled: boolean; botId: string; receivers: string; title: string; events: Record<string, boolean> };
  const [mn, setMn] = useState<MnConfig | null>(null);
  const [mnEventDefs, setMnEventDefs] = useState<{ key: string; label: string; group?: string }[]>([]);
  const [mnBusy, setMnBusy] = useState(false);
  const [mnMsg, setMnMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const notifyRes = await fetch("/api/b2b/settings/notify", { cache: "no-store" });
        const j = await notifyRes.json();
        if (!notifyRes.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setConfig(j.config || {});
        setEvents(j.events || []);
        const dg = await (await fetch("/api/b2b/settings/digest", { cache: "no-store" })).json();
        if (dg.ok) {
          setDcfg(dg.config); setDigestLastSent(dg.lastSent || null); setCronSecretSet(dg.cronSecretSet !== false);
          if (Array.isArray(dg.config?.times) && dg.config.times.length) setDtimes(dg.config.times);
        }
        const mnRes = await (await fetch("/api/production/settings/master-notify", { cache: "no-store" })).json();
        if (mnRes.ok) { setMn(mnRes.config); setMnEventDefs(mnRes.events || []); }
      } catch (e) {
        setError(e instanceof Error ? e.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  async function loadDigest() {
    setDigestBusy(true); setDigestMsg(null);
    try { const j = await (await fetch("/api/b2b/schedule-digest", { cache: "no-store" })).json(); if (!j.ok) throw new Error(j.error || "미리보기 실패"); setDigest(j.preview || ""); }
    catch (e) { setDigestMsg({ ok: false, text: e instanceof Error ? e.message : "미리보기 실패" }); }
    setDigestBusy(false);
  }
  async function sendDigestNow() {
    if (!window.confirm("지금 '아침 일정 알림'을 Teams 채널로 보낼까요?")) return;
    setDigestBusy(true); setDigestMsg(null);
    try { const j = await (await fetch("/api/b2b/schedule-digest?send=1", { cache: "no-store" })).json(); if (!j.ok) throw new Error(j.error || "발송 실패"); setDigestMsg({ ok: true, text: "발송 완료" }); }
    catch (e) { setDigestMsg({ ok: false, text: e instanceof Error ? e.message : "발송 실패" }); }
    setDigestBusy(false);
  }
  async function saveDigestCfg() {
    if (!dcfg) return;
    setDcfgSaving(true); setDigestMsg(null);
    try {
      const j = await (await fetch("/api/b2b/settings/digest", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...dcfg, times: dtimes }) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setDcfg(j.config);
      if (Array.isArray(j.config?.times) && j.config.times.length) setDtimes(j.config.times);
      setDigestMsg({ ok: true, text: "저장됨" });
    }
    catch (e) { setDigestMsg({ ok: false, text: e instanceof Error ? e.message : "저장 실패" }); }
    setDcfgSaving(false);
  }

  async function saveMn() {
    if (!mn) return;
    setMnBusy(true); setMnMsg(null);
    try {
      const r = await fetch("/api/production/settings/master-notify", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mn) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMnMsg({ kind: "ok", text: "저장됨" });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "저장 오류" }); }
    setMnBusy(false);
  }
  async function testMn() {
    setMnBusy(true); setMnMsg(null);
    try {
      const r = await fetch("/api/production/settings/master-notify", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "테스트 실패");
      setMnMsg({ kind: "ok", text: "테스트 알림을 보냈습니다. Teams 변경알림 채널을 확인하세요." });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "테스트 실패" }); }
    setMnBusy(false);
  }

  function isToggleOn(key: string): boolean {
    return config[key] === true;
  }
  function setToggle(key: string, on: boolean) {
    setConfig((prev) => ({ ...prev, [key]: on }));
    setSavedAt("");
  }
  function isStatusOn(key: string, status: string): boolean {
    const v = config[key];
    return Array.isArray(v) && v.includes(status);
  }
  function toggleStatus(key: string, status: string) {
    setConfig((prev) => {
      const v = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
      const next = v.includes(status) ? v.filter((s) => s !== status) : [...v, status];
      return { ...prev, [key]: next };
    });
    setSavedAt("");
  }
  function setAllStatuses(ev: EventMeta, on: boolean) {
    setConfig((prev) => ({ ...prev, [ev.key]: on ? [...(ev.statuses || [])] : [] }));
    setSavedAt("");
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/settings/notify", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      const d = new Date();
      setSavedAt(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 저장됨`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 중 오류");
    }
    setSaving(false);
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · Teams 연동</h1>
        </div>
        <div className="b2b-page-actions">
          {savedAt && <span style={{ fontSize: 12, color: "var(--sm-success)", alignSelf: "center" }}>{savedAt}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* Teams 채널 웹훅 — 모든 알림의 발송 대상 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">Teams 알림</h2>
          <span className="b2b-status-pill" style={teamsEnabled && teamsHasUrl
            ? { background: "var(--sm-success-bg)", color: "var(--sm-success)" }
            : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>
            {teamsEnabled && teamsHasUrl ? "발송 중" : "꺼짐"}
          </span>
        </div>
        <div className="sm-col" style={{ gap: 10, maxWidth: 640 }}>
          <label className="b2b-field">
            <span className="b2b-field-label">B2B 알림 채널 URL {teamsHasUrl && <span className="sm-faint" style={{ fontWeight: 400 }}>· 저장됨 {teamsTail}</span>}</span>
            <input className="b2b-input" type="password" value={teamsUrl} onChange={(e) => setTeamsUrl(e.target.value)}
              placeholder={teamsHasUrl ? "새 URL로 바꿀 때만 입력" : "https://..."} autoComplete="off" />
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">업무도우미 변경알림 채널 URL <span className="sm-faint" style={{ fontWeight: 400 }}>{teamsHasHelper ? `· 저장됨 ${teamsHelperTail}` : "· 비우면 B2B 채널로 함께 발송"}</span></span>
            <input className="b2b-input" type="password" value={teamsHelperUrl} onChange={(e) => setTeamsHelperUrl(e.target.value)}
              placeholder={teamsHasHelper ? "새 URL로 바꿀 때만 입력" : "https://..."} autoComplete="off" />
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">클레임 알림 채널 URL <span className="sm-faint" style={{ fontWeight: 400 }}>{teamsHasClaims ? `· 저장됨 ${teamsClaimsTail}` : "· 비우면 변경알림·B2B 채널로 폴백"}</span></span>
            <input className="b2b-input" type="password" value={teamsClaimsUrl} onChange={(e) => setTeamsClaimsUrl(e.target.value)}
              placeholder={teamsHasClaims ? "새 URL로 바꿀 때만 입력" : "https://..."} autoComplete="off" />
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">고객문의 알림 채널 URL <span className="sm-faint" style={{ fontWeight: 400 }}>{teamsHasInquiry ? `· 저장됨 ${teamsInquiryTail}` : "· 비우면 클레임 채널로 폴백"}</span></span>
            <input className="b2b-input" type="password" value={teamsInquiryUrl} onChange={(e) => setTeamsInquiryUrl(e.target.value)}
              placeholder={teamsHasInquiry ? "새 URL로 바꿀 때만 입력" : "https://..."} autoComplete="off" />
          </label>
          <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label className="sm-row" style={{ gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" className="b2b-checkbox" checked={teamsEnabled}
                onChange={(e) => { setTeamsEnabled(e.target.checked); saveTeams(e.target.checked); }} /> Teams로 발송 켜기
            </label>
            <button className="b2b-btn-primary" onClick={() => saveTeams()} disabled={teamsBusy}>{teamsBusy ? "처리 중..." : "저장"}</button>
            <button className="b2b-btn-secondary" onClick={testTeams} disabled={teamsBusy || !teamsHasUrl} title={teamsHasUrl ? "" : "URL을 먼저 저장하세요"}>테스트 발송</button>
          </div>
          {teamsMsg && (
            <div className={teamsMsg.ok ? "sm-success" : "b2b-error"} style={{ fontSize: 13 }}>{teamsMsg.text}</div>
          )}
        </div>
      </section>

      {/* 아침 일정 알림 — Teams 채널(B2B 알림)로 자동 발송 */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">아침 일정 알림</h2>
          <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>
            마지막 자동 발송: <strong style={{ color: digestLastSent ? "var(--sm-success)" : "var(--sm-danger)" }}>{digestLastSent || "기록 없음"}</strong>
            {!cronSecretSet && <strong style={{ color: "var(--sm-danger)", marginLeft: 8 }}>CRON_SECRET 미설정 — 자동 발송이 매일 실패합니다</strong>}
          </span>
        </div>
        {dcfg && (
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: 14, marginBottom: 12, display: "grid", gap: 12 }}>
            <label className="sm-row" style={{ gap: 7, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              <input type="checkbox" className="b2b-checkbox" checked={dcfg.enabled} onChange={(e) => setDcfg({ ...dcfg, enabled: e.target.checked })} /> 자동 발송 사용
            </label>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>발송 시각 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 11 }}>(한국시간 · 5분 단위 · 최대 6개)</span></div>
              <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {dtimes.map((t) => (
                  <span key={t} className="b2b-status-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    {t}
                    {dtimes.length > 1 && (
                      <button type="button" aria-label={`${t} 삭제`} onClick={() => setDtimes((p) => p.filter((x) => x !== t))}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0, font: "inherit" }}>✕</button>
                    )}
                  </span>
                ))}
                <input type="time" className="b2b-input" step={300} value={newTime} onChange={(e) => setNewTime(e.target.value)} style={{ width: "auto", padding: "6px 10px" }} />
                <button type="button" className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }}
                  disabled={dtimes.length >= 6}
                  onClick={() => {
                    // 5분 단위 내림 — 서버 정규화와 동일 규칙(그 사이 시각은 틱이 영영 안 울린다)
                    const [h, m] = newTime.split(":").map(Number);
                    if (Number.isNaN(h) || Number.isNaN(m)) return;
                    const t = `${String(h).padStart(2, "0")}:${String(Math.floor(m / 5) * 5).padStart(2, "0")}`;
                    setDtimes((p) => (p.includes(t) ? p : [...p, t].sort().slice(0, 6)));
                  }}>+ 추가</button>
              </div>
            </div>
            <label className="sm-row" style={{ gap: 6, fontSize: 13 }}>전후 기간
              <input type="number" className="b2b-input" style={{ width: 70 }} min={1} max={31} value={dcfg.days} onChange={(e) => setDcfg({ ...dcfg, days: Number(e.target.value) })} />일
              <span className="sm-faint" style={{ fontSize: 11 }}>계산서·입금은 기간 무관</span>
            </label>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>보낼 내용</div>
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap" }}>
                {([["ship", "발송 예정"], ["unscheduled", "발송일정 미등록"], ["invoice", "계산서 미발행"], ["payment", "입금 대기"]] as const).map(([k, l]) => (
                  <label key={k} className="sm-row" style={{ gap: 5, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" className="b2b-checkbox" checked={!!dcfg.sections[k]} onChange={(e) => setDcfg({ ...dcfg, sections: { ...dcfg.sections, [k]: e.target.checked } })} /> {l}
                  </label>
                ))}
              </div>
            </div>
            <label style={{ fontSize: 13 }}>제목
              <input className="b2b-input" style={{ marginTop: 4 }} value={dcfg.title} onChange={(e) => setDcfg({ ...dcfg, title: e.target.value })} placeholder="씨몬스터 B2B 오늘의 할 일" />
            </label>
            <div><button className="b2b-btn-primary" onClick={saveDigestCfg} disabled={dcfgSaving}>{dcfgSaving ? "저장 중..." : "설정 저장"}</button></div>
          </div>
        )}
        <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: digest ? 10 : 0 }}>
          <button className="b2b-btn-secondary" onClick={loadDigest} disabled={digestBusy}>{digestBusy ? "..." : "미리보기"}</button>
          <button className="b2b-btn-primary" onClick={sendDigestNow} disabled={digestBusy || !teamsEnabled} title={teamsEnabled ? "" : "먼저 Teams 알림을 켜세요"}>지금 보내기</button>
          {digestMsg && <span style={{ fontSize: 12, color: digestMsg.ok ? "var(--sm-success)" : "var(--sm-danger)" }}>{digestMsg.text}</span>}
        </div>
        {digest && <pre style={{ fontSize: 12, background: "var(--sm-bg)", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0, fontFamily: "inherit" }}>{digest}</pre>}
      </section>

      {!teamsEnabled && (
        <div className="sm-warn">
          <strong>외부 알림 대상이 없습니다.</strong> 위 <strong>Teams 알림</strong>(URL 저장 + 발송 켜기)을 설정하세요.
        </div>
      )}

      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">알림 이벤트</h2>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : (
          <div className="b2b-notify-list">
            {events.map((ev) => (
              <div key={ev.key} className="b2b-notify-row">
                <div className="b2b-notify-info">
                  <div className="b2b-notify-label">{ev.label}</div>
                </div>

                {ev.kind === "toggle" ? (
                  <label className="b2b-notify-toggle">
                    <input
                      type="checkbox"
                      className="b2b-checkbox"
                      checked={isToggleOn(ev.key)}
                      onChange={(e) => setToggle(ev.key, e.target.checked)}
                    />
                    <span>알림 발송</span>
                  </label>
                ) : (
                  <div className="b2b-notify-statuses">
                    {(ev.statuses || []).map((s) => (
                      <label key={s} className={`b2b-notify-chip ${isStatusOn(ev.key, s) ? "is-on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={isStatusOn(ev.key, s)}
                          onChange={() => toggleStatus(ev.key, s)}
                        />
                        {statusLabel(s)}
                      </label>
                    ))}
                    <button
                      type="button"
                      className="b2b-notify-all"
                      onClick={() => {
                        const allOn = (ev.statuses || []).every((s) => isStatusOn(ev.key, s));
                        setAllStatuses(ev, !allOn);
                      }}
                    >
                      {(ev.statuses || []).every((s) => isStatusOn(ev.key, s)) ? "전체 끄기" : "전체 켜기"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* [업무도우미 변경알림] — 상품마스터 변경 + 생산·재고 알림 체크리스트 (구 생산관리 설정에서 이관) */}
      <section className="b2b-card" style={{ marginTop: 28 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">[업무도우미 변경알림]</h2>
          <button className="b2b-btn-primary" onClick={saveMn} disabled={mnBusy || !mn}>{mnBusy ? "저장 중..." : "저장"}</button>
        </div>
        {mnMsg && <div className={mnMsg.kind === "ok" ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{mnMsg.text}</div>}
        {mn && (
          <>
            <label className="sm-row" style={{ gap: 6, fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              <input type="checkbox" className="b2b-checkbox" checked={mn.enabled} onChange={(e) => setMn({ ...mn, enabled: e.target.checked })} />
              상품마스터 변경알림 켜기 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>· 생산·재고 알림과 무관</span>
            </label>
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>발송할 알림 목록</span>
              {[...new Set(mnEventDefs.map((ev) => ev.group || "기타"))].map((g) => (
                <div key={g} style={{ marginTop: 8 }}>
                  <div className="sm-faint" style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{g}</div>
                  <div className="sm-row" style={{ gap: 14, flexWrap: "wrap" }}>
                    {mnEventDefs.filter((ev) => (ev.group || "기타") === g).map((ev) => (
                      <label key={ev.key} className="sm-row" style={{ gap: 5, fontSize: 15 }}>
                        <input type="checkbox" className="b2b-checkbox" checked={mn.events[ev.key] !== false}
                          onChange={(e) => setMn({ ...mn, events: { ...mn.events, [ev.key]: e.target.checked } })} />
                        {ev.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="sm-row" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
              <button className="b2b-btn-secondary" onClick={testMn} disabled={mnBusy}>테스트 발송</button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
