"use client";

import { useEffect, useState } from "react";

export default function VocSettingsPage() {
  const [origin, setOrigin] = useState("");
  const [loading, setLoading] = useState(true);
  // API(pull)
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [formId, setFormId] = useState("");
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  // 웹훅(대안)
  const [hasSecret, setHasSecret] = useState(false);
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);

  const webhookUrl = origin ? `${origin}/api/voc/tally` : "/api/voc/tally";

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/voc/tally-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      setHasApiKey(!!j.hasApiKey); setHasSecret(!!j.hasSecret); setFormId(j.formId || "");
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function save(body: Record<string, string>, okMsg: string, tag: string) {
    setBusy(tag); setMsg(null);
    try {
      const res = await fetch("/api/voc/tally-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMsg({ t: okMsg, ok: true });
      return true;
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "저장 실패", ok: false }); return false; }
    finally { setBusy(""); }
  }

  async function saveApiKey() {
    if (await save({ apiKey }, apiKey.trim() ? "API 키 저장됨" : "API 키 해제됨", "key")) { setHasApiKey(!!apiKey.trim()); setApiKey(""); }
  }
  async function loadForms() {
    setBusy("forms"); setMsg(null);
    try {
      const j = await (await fetch("/api/voc/tally/forms", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "폼 조회 실패");
      setForms(j.forms || []);
      if (!j.forms?.length) setMsg({ t: "폼이 없습니다. API 키를 확인하세요.", ok: false });
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "폼 조회 실패", ok: false }); }
    finally { setBusy(""); }
  }
  async function selectForm(id: string) { setFormId(id); await save({ formId: id }, "가져올 폼 저장됨", "form"); }
  async function importNow() {
    setBusy("import"); setMsg(null);
    try {
      const j = await (await fetch("/api/voc/tally/import", { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error || "가져오기 실패");
      setMsg({ t: `가져오기 완료 — 신규 ${j.imported}건 (중복 ${j.skipped} / 조회 ${j.scanned})`, ok: true });
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "가져오기 실패", ok: false }); }
    finally { setBusy(""); }
  }
  async function saveSecret() {
    if (await save({ secret }, secret.trim() ? "시크릿 저장됨" : "시크릿 해제됨", "secret")) { setHasSecret(!!secret.trim()); setSecret(""); }
  }
  function copyUrl() { navigator.clipboard.writeText(webhookUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · 탈리(Tally) 연동</h1>
          <p className="b2b-page-subtitle">Tally 설문 응답을 <a href="/voc/surveys" className="change-link">설문 응답 수집</a>으로 가져옵니다(불만 클레임과 분리). 모든 질문·답변이 그대로 보존되고 사진도 함께 저장됩니다.</p>
        </div>
      </header>

      {msg && <div className={msg.ok ? "b2b-card" : "b2b-error"} style={msg.ok ? { borderColor: "var(--sm-success)", color: "var(--sm-success)", padding: "10px 14px", fontSize: 13, fontWeight: 600 } : undefined}>{msg.t}</div>}

      {/* API 키 방식(권장) */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">API 연동 (권장)</span></div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 16 }}>
          <span className="b2b-field-label">1) Tally API 키 · 현재 {loading ? "확인 중…" : hasApiKey ? <strong style={{ color: "var(--sm-success)" }}>저장됨</strong> : <strong style={{ color: "var(--sm-warning)" }}>미설정</strong>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasApiKey ? "새 키로 변경(비우고 저장 시 해제)" : "tally_xxx API 키 붙여넣기"} style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-primary" onClick={saveApiKey} disabled={busy === "key"}>{busy === "key" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>Tally → 우상단 프로필 → Settings → API keys 에서 발급.</span>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 16 }}>
          <span className="b2b-field-label">2) 가져올 폼 {formId && <span className="sm-faint">· 현재: {formId}</span>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="b2b-btn-secondary" onClick={loadForms} disabled={busy === "forms" || !hasApiKey}>{busy === "forms" ? "불러오는 중…" : "폼 불러오기"}</button>
            {forms.length > 0 && (
              <select className="b2b-input" value={formId} onChange={(e) => selectForm(e.target.value)} style={{ flex: 1, minWidth: 240 }}>
                <option value="">폼 선택…</option>
                {forms.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.id})</option>)}
              </select>
            )}
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6 }}>
          <span className="b2b-field-label">3) 응답 가져오기</span>
          <div className="sm-row" style={{ gap: 8 }}>
            <button className="b2b-btn-primary" onClick={importNow} disabled={busy === "import" || !hasApiKey || !formId}>{busy === "import" ? "가져오는 중…" : "지금 가져오기"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>이전에 가져온 응답은 자동으로 건너뜁니다(중복 방지). 처음엔 최근 60일치를 가져옵니다.</span>
        </div>
      </section>

      {/* 웹훅 방식(대안) */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">웹훅 (대안 · 실시간)</span></div>
        <p className="sm-muted" style={{ fontSize: 13, marginBottom: 10 }}>API 키 대신, Tally 유료 플랜의 웹훅으로 실시간 수신도 가능합니다. 아래 주소를 Tally 폼 Integrations→Webhooks 에 붙여넣고, Signing secret 을 저장하세요.</p>
        <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input className="b2b-input" readOnly value={webhookUrl} style={{ flex: 1, minWidth: 240, fontFamily: "monospace" }} onFocus={(e) => e.target.select()} />
          <button className="b2b-btn-secondary" onClick={copyUrl}>{copied ? "복사됨 ✓" : "복사"}</button>
        </div>
        <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="b2b-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hasSecret ? "변경(비우고 저장 시 해제)" : "Signing secret (선택)"} style={{ flex: 1, minWidth: 240 }} />
          <button className="b2b-btn-secondary" onClick={saveSecret} disabled={busy === "secret"}>{busy === "secret" ? "저장 중…" : "시크릿 저장"}</button>
        </div>
      </section>
    </div>
  );
}
