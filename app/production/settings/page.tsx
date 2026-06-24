"use client";

import { useEffect, useState } from "react";

type AliasItem = { sku: string; names: string[]; canonical: string; alias: string; display: string };

export default function ProductionSettingsPage() {
  const [configured, setConfigured] = useState(false);
  const [masked, setMasked] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [aliasItems, setAliasItems] = useState<AliasItem[]>([]);
  const [aliasInput, setAliasInput] = useState<Record<string, string>>({});
  const [aliasSavingSku, setAliasSavingSku] = useState<string | null>(null);

  async function loadStatus() {
    try {
      const j = await (await fetch("/api/production/settings", { cache: "no-store" })).json();
      if (j.ok) { setConfigured(j.configured); setMasked(j.masked || ""); }
    } catch { /* noop */ }
  }
  async function loadAliases() {
    try {
      const j = await (await fetch("/api/production/item-alias", { cache: "no-store" })).json();
      if (j.ok) {
        setAliasItems(j.items || []);
        const inputs: Record<string, string> = {};
        for (const it of j.items || []) inputs[it.sku] = it.alias || "";
        setAliasInput(inputs);
      }
    } catch { /* noop */ }
  }
  useEffect(() => { loadStatus(); loadAliases(); }, []);

  async function saveAlias(sku: string) {
    setAliasSavingSku(sku);
    try {
      const res = await fetch("/api/production/item-alias", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, name: aliasInput[sku] || "" }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      await loadAliases();
    } catch { /* noop */ }
    setAliasSavingSku(null);
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
          <p className="b2b-page-subtitle">박스히어로 연동 + 생산 품목명 정리.</p>
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

      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">생산 품목명</h2></div>
        <p style={{ fontSize: 13, color: "var(--sm-text-mid)", margin: "0 0 14px", lineHeight: 1.6 }}>
          B2B에서 같은 제품을 업체별로 다른 품목명으로 부르면(단가 차이 등) 생산에서 갈라집니다.
          같은 <strong>SKU</strong>는 생산에선 한 품목으로 묶이며, 여기서 <strong>생산 표시명</strong>만 정리하면 됩니다. (비우면 가장 짧은 이름 자동 사용)
        </p>
        {aliasItems.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>정리할 품목이 없습니다. (같은 SKU에 이름이 여러 개인 경우만 표시)</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {aliasItems.map((it) => (
              <div key={it.sku} style={{ borderTop: "1px solid var(--sm-border)", paddingTop: 12 }}>
                <div style={{ fontSize: 12, color: "var(--sm-text-light)", marginBottom: 4 }}>
                  <code>{it.sku}</code> · B2B 품목명: {it.names.join(" / ")}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    className="b2b-input"
                    value={aliasInput[it.sku] ?? ""}
                    onChange={(e) => setAliasInput((m) => ({ ...m, [it.sku]: e.target.value }))}
                    placeholder={it.canonical}
                    style={{ flex: 1, minWidth: 240 }}
                  />
                  <button className="b2b-btn-secondary" onClick={() => saveAlias(it.sku)} disabled={aliasSavingSku === it.sku}>
                    {aliasSavingSku === it.sku ? "..." : "저장"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
