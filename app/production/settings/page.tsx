"use client";

import { useEffect, useState } from "react";

export default function ProductionSettingsPage() {
  const [configured, setConfigured] = useState(false);
  const [masked, setMasked] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [leadInput, setLeadInput] = useState("");
  const [leadSaved, setLeadSaved] = useState<number | null>(null);
  const [leadSaving, setLeadSaving] = useState(false);
  const [leadMsg, setLeadMsg] = useState("");

  // [업무도우미 변경알림] — 상품마스터 변경 시 Flow 알림봇으로 수신자들에게 발송(B2B 도매 봇과 별개)
  type MnConfig = { enabled: boolean; botId: string; receivers: string; title: string; events: Record<string, boolean> };
  const [mn, setMn] = useState<MnConfig | null>(null);
  const [mnEventDefs, setMnEventDefs] = useState<{ key: string; label: string }[]>([]);
  const [mnApiKey, setMnApiKey] = useState("");       // 입력 시에만 갱신(빈값이면 기존 키 유지)
  const [mnHasKey, setMnHasKey] = useState(false);
  const [mnFallbackKey, setMnFallbackKey] = useState(false); // 전용 키 없이 B2B 봇 키 폴백 중
  const [mnTestReceiver, setMnTestReceiver] = useState("");
  const [mnBusy, setMnBusy] = useState(false);
  const [mnMsg, setMnMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function loadStatus() {
    try {
      const j = await (await fetch("/api/production/settings", { cache: "no-store" })).json();
      if (j.ok) { setConfigured(j.configured); setMasked(j.masked || ""); }
    } catch { /* noop */ }
  }
  async function loadLead() {
    try {
      const j = await (await fetch("/api/production/lead-days", { cache: "no-store" })).json();
      if (j.ok) { setLeadSaved(j.leadDays); setLeadInput(String(j.leadDays)); }
    } catch { /* noop */ }
  }
  async function loadMn() {
    try {
      const j = await (await fetch("/api/production/settings/master-notify", { cache: "no-store" })).json();
      if (j.ok) { setMn(j.config); setMnEventDefs(j.events || []); setMnHasKey(!!j.hasApiKey); setMnFallbackKey(!!j.fallbackKey); }
    } catch { /* noop */ }
  }
  useEffect(() => { loadStatus(); loadLead(); loadMn(); }, []);

  async function saveMn() {
    if (!mn) return;
    setMnBusy(true); setMnMsg(null);
    try {
      const body: Record<string, unknown> = { ...mn };
      if (mnApiKey.trim()) body.apiKey = mnApiKey.trim();
      const r = await fetch("/api/production/settings/master-notify", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      if (mnApiKey.trim()) { setMnHasKey(true); setMnFallbackKey(false); setMnApiKey(""); }
      setMnMsg({ kind: "ok", text: "저장됨" });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "저장 오류" }); }
    setMnBusy(false);
  }
  async function testMn() {
    setMnBusy(true); setMnMsg(null);
    try {
      const r = await fetch("/api/production/settings/master-notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mnTestReceiver.trim() ? { testReceiver: mnTestReceiver.trim() } : {}) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "테스트 실패");
      setMnMsg({ kind: "ok", text: "테스트 알림을 보냈습니다. Flow 를 확인하세요." });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "테스트 실패" }); }
    setMnBusy(false);
  }

  async function saveLead() {
    const n = Math.round(Number(leadInput));
    if (!Number.isFinite(n) || n < 1 || n > 60) { setLeadMsg("1~60 사이 숫자를 입력하세요."); return; }
    setLeadSaving(true);
    setLeadMsg("");
    try {
      const res = await fetch("/api/production/lead-days", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: n }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setLeadSaved(j.leadDays);
      setLeadInput(String(j.leadDays));
      setLeadMsg(`저장됨 — 안전재고가 하루 출고 × ${j.leadDays}일로 계산됩니다.`);
    } catch (e) {
      setLeadMsg(e instanceof Error ? e.message : "저장 실패");
    }
    setLeadSaving(false);
  }

  async function save() {
    if (!token.trim()) { setMsg({ kind: "err", text: "토큰을 입력하세요." }); return; }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/production/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMsg({ kind: "ok", text: "박스히어로 연결 성공 — 토큰을 저장했습니다." });
      setToken("");
      await loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "저장 실패" });
    }
    setSaving(false);
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정</h1>
        </div>
      </header>

      <section className="b2b-card">
        <div className="b2b-card-head"><h2 className="b2b-card-title">박스히어로 연동</h2></div>
        <div style={{ padding: "4px 2px 2px" }}>
          <div style={{ marginBottom: 14, fontSize: 12.5, color: "var(--sm-text-mid)", lineHeight: 1.6 }}>
            상태:{" "}
            {configured
              ? <span style={{ color: "var(--sm-success)", fontWeight: 600 }}>연결됨 ({masked})</span>
              : <span style={{ color: "var(--sm-danger)", fontWeight: 600 }}>미설정</span>}
            <br />
            박스히어로 앱 → 설정 &gt; 통합 설정 &gt; API 에서 토큰을 발급해 붙여넣으세요. 저장 시 자동으로 연결을 확인합니다.
          </div>

          <div className="b2b-field">
            <label className="b2b-field-label">API 토큰</label>
            <input
              className="b2b-input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={configured ? "새 토큰으로 교체하려면 입력" : "토큰 붙여넣기"}
              autoComplete="off"
            />
          </div>

          {msg && (
            <div style={{ marginTop: 10, fontSize: 12, color: msg.kind === "ok" ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 600 }}>
              {msg.text}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>
              {saving ? "확인 중..." : "저장 + 연결 확인"}
            </button>
          </div>
        </div>
      </section>

      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">생산 리드타임</h2></div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px", lineHeight: 1.6 }}>
          제조사에 생산을 요청하고 받기까지 걸리는 일수입니다. <strong>안전재고 = 하루 평균 출고 × 리드타임</strong>으로,
          이 기간 팔릴 만큼은 늘 확보해 재고 쇼트를 막습니다. {leadSaved != null && <>현재 <strong>{leadSaved}일</strong>.</>}
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="b2b-input"
            type="number"
            min={1}
            max={60}
            value={leadInput}
            onChange={(e) => setLeadInput(e.target.value)}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>일</span>
          <button className="b2b-btn-primary" onClick={saveLead} disabled={leadSaving}>
            {leadSaving ? "저장 중..." : "저장"}
          </button>
        </div>
        {leadMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: leadMsg.startsWith("저장됨") ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 600 }}>
            {leadMsg}
          </div>
        )}
      </section>

      {/* [업무도우미 변경알림] — 상품마스터 변경 시 Flow 알림봇으로 수신자들에게 발송 */}
      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">[업무도우미 변경알림] <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 상품마스터 변경 시 Flow 알림 발송 (B2B 도매 알림봇과 별개 봇)</span></h2>
          <button className="b2b-btn-primary" onClick={saveMn} disabled={mnBusy || !mn}>{mnBusy ? "저장 중..." : "저장"}</button>
        </div>
        {mnMsg && <div className={mnMsg.kind === "ok" ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{mnMsg.text}</div>}
        {mn && (
          <>
            <label className="sm-row" style={{ gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              <input type="checkbox" className="b2b-checkbox" checked={mn.enabled} onChange={(e) => setMn({ ...mn, enabled: e.target.checked })} />
              변경알림 켜기
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>봇 ID</span>
                <input className="b2b-input" value={mn.botId} onChange={(e) => setMn({ ...mn, botId: e.target.value })} placeholder="BFLOW_300003566171" /></label>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>알림 제목</span>
                <input className="b2b-input" value={mn.title} onChange={(e) => setMn({ ...mn, title: e.target.value })} placeholder="[업무도우미 변경알림]" /></label>
              <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>수신 대상 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 11.5 }}>· 쉼표로 구분(B2B 알림봇 수신자와 같은 ID 형식)</span></span>
                <input className="b2b-input" value={mn.receivers} onChange={(e) => setMn({ ...mn, receivers: e.target.value })} placeholder="예: user1@seamonster.kr, user2@seamonster.kr" /></label>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>Flow API 키 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 11.5 }}>{mnHasKey ? "· 저장됨(입력 시 교체)" : mnFallbackKey ? "· B2B 봇 키 사용 중(입력 시 전용 키)" : "· 미설정"}</span></span>
                <input className="b2b-input" type="password" value={mnApiKey} onChange={(e) => setMnApiKey(e.target.value)} placeholder={mnHasKey || mnFallbackKey ? "변경할 때만 입력" : "키관리에서 발급받은 API Key"} /></label>
            </div>
            <div style={{ marginTop: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>발송할 변경 목록</span>
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginTop: 6 }}>
                {mnEventDefs.map((ev) => (
                  <label key={ev.key} className="sm-row" style={{ gap: 5, fontSize: 13 }}>
                    <input type="checkbox" className="b2b-checkbox" checked={mn.events[ev.key] !== false}
                      onChange={(e) => setMn({ ...mn, events: { ...mn.events, [ev.key]: e.target.checked } })} />
                    {ev.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="sm-row" style={{ gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <input className="b2b-input" style={{ width: 220 }} value={mnTestReceiver} onChange={(e) => setMnTestReceiver(e.target.value)} placeholder="테스트 수신자(비우면 전체)" />
              <button className="b2b-btn-secondary" onClick={testMn} disabled={mnBusy}>테스트 발송</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
