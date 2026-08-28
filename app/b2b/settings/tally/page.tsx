"use client";

import { useEffect, useState } from "react";

// 설정 · Tally 연동 — 설문 응답을 VOC로 가져오는 API 연결 (구 VOC 설정에서 이관, 2026-08-24 설정 재구성).
export default function TallySettingsPage() {
  const [loading, setLoading] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [formId, setFormId] = useState("");
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [loadFail, setLoadFail] = useState(false); // 조회 실패 — '미설정'으로 보이면 키를 다시 발급하는 헛걸음을 유도한다

  useEffect(() => {
    fetch("/api/voc/tally-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      setHasApiKey(!!j.hasApiKey); setFormId(j.formId || "");
    }).catch(() => setLoadFail(true)).finally(() => setLoading(false));
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

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · Tally 연동</h1>
        </div>
      </header>

      {msg && <div className={msg.ok ? "sm-success" : "b2b-error"}>{msg.t}</div>}

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">Tally API 연동</span></div>
        <p className="sm-muted" style={{ fontSize: 15, marginBottom: 12 }}>탈리(Tally) 설문 응답을 VOC로 가져옵니다. 가져온 응답은 VOC 관리의 &apos;설문 응답(Tally)&apos; 화면에서 확인합니다.</p>

        <div className="sm-col" style={{ gap: 6, marginBottom: 16 }}>
          <span className="b2b-field-label">1) Tally API 키 · 현재 {loading ? "확인 중..." : loadFail ? <strong style={{ color: "var(--sm-danger)" }}>확인 실패 — 새로고침</strong> : hasApiKey ? <strong style={{ color: "var(--sm-success)" }}>저장됨</strong> : <strong style={{ color: "var(--sm-warning)" }}>미설정</strong>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasApiKey ? "새 키로 변경(비우고 저장 시 해제)" : "tally_xxx API 키 붙여넣기"} style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-primary" onClick={saveApiKey} disabled={busy === "key"}>{busy === "key" ? "저장 중..." : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>Tally → 우상단 프로필 → Settings → API keys 에서 발급.</span>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 16 }}>
          <span className="b2b-field-label">2) 가져올 폼 {formId && <span className="sm-faint">· 현재: {formId}</span>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="b2b-btn-secondary" onClick={loadForms} disabled={busy === "forms" || !hasApiKey}>{busy === "forms" ? "불러오는 중..." : "폼 불러오기"}</button>
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
            <button className="b2b-btn-primary" onClick={importNow} disabled={busy === "import" || !hasApiKey || !formId}>{busy === "import" ? "가져오는 중..." : "지금 가져오기"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>이전에 가져온 응답은 자동으로 건너뜁니다(중복 방지). 처음엔 최근 60일치를 가져옵니다.</span>
        </div>
      </section>
    </div>
  );
}
