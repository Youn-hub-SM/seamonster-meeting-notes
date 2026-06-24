"use client";

import { useEffect, useState } from "react";

export default function ProductionSettingsPage() {
  const [configured, setConfigured] = useState(false);
  const [masked, setMasked] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function loadStatus() {
    try {
      const j = await (await fetch("/api/production/settings", { cache: "no-store" })).json();
      if (j.ok) { setConfigured(j.configured); setMasked(j.masked || ""); }
    } catch { /* noop */ }
  }
  useEffect(() => { loadStatus(); }, []);

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
          <p className="b2b-page-subtitle">박스히어로 API 연동 토큰을 등록합니다.</p>
        </div>
      </header>

      <section className="b2b-card">
        <div className="b2b-card-head"><h2 className="b2b-card-title">박스히어로 연동</h2></div>
        <div style={{ padding: "4px 2px 2px" }}>
          <div style={{ marginBottom: 14, fontSize: 13.5, color: "var(--sm-text-mid)", lineHeight: 1.6 }}>
            상태:{" "}
            {configured
              ? <span style={{ color: "#22863a", fontWeight: 600 }}>연결됨 ({masked})</span>
              : <span style={{ color: "#c92a2a", fontWeight: 600 }}>미설정</span>}
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
            <div style={{ marginTop: 10, fontSize: 13, color: msg.kind === "ok" ? "#22863a" : "#c92a2a", fontWeight: 600 }}>
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
    </div>
  );
}
