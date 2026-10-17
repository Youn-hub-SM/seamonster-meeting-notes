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
      if (!res.ok || !j.ok) throw new Error(j.error || "설정을 저장하지 못했습니다. 입력값을 확인하세요");
      setMsg({ t: okMsg, ok: true });
      return true;
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "설정을 저장하지 못했습니다. 입력값을 확인하세요", ok: false }); return false; }
    finally { setBusy(""); }
  }

  async function saveApiKey() {
    if (await save({ apiKey }, apiKey.trim() ? "API 키를 저장했습니다" : "API 키를 해제했습니다", "key")) { setHasApiKey(!!apiKey.trim()); setApiKey(""); }
  }
  async function loadForms() {
    setBusy("forms"); setMsg(null);
    try {
      const j = await (await fetch("/api/voc/tally/forms", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "폼을 불러오지 못했습니다. API 키를 확인하세요");
      setForms(j.forms || []);
      if (!j.forms?.length) setMsg({ t: "폼이 없습니다. Tally 에서 폼을 만든 뒤 다시 불러오세요", ok: false });
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "폼을 불러오지 못했습니다. API 키를 확인하세요", ok: false }); }
    finally { setBusy(""); }
  }
  async function selectForm(id: string) { setFormId(id); await save({ formId: id }, "가져올 폼을 저장했습니다", "form"); }
  async function importNow() {
    setBusy("import"); setMsg(null);
    try {
      const j = await (await fetch("/api/voc/tally/import", { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error || "응답을 가져오지 못했습니다. API 키와 폼을 확인하세요");
      setMsg({ t: `응답을 가져왔습니다 — 신규 ${j.imported}건 (중복 ${j.skipped} / 조회 ${j.scanned})`, ok: true });
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "응답을 가져오지 못했습니다. API 키와 폼을 확인하세요", ok: false }); }
    finally { setBusy(""); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">Tally 연동</h1>
        </div>
      </header>

      {msg && <div className={msg.ok ? "sm-success" : "b2b-error"}>{msg.t}</div>}

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">Tally API 연동</span></div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 16 }}>
          <span className="b2b-field-label">1) Tally API 키 <span className="opt">{loading ? "확인 중..." : loadFail ? <strong style={{ color: "var(--sm-danger)" }}>확인하지 못했습니다. 새로고침하세요</strong> : hasApiKey ? "저장됨" : "미설정"}</span></span>
          <span className="b2b-field-hint">{hasApiKey ? "새 키를 넣고 저장하면 변경, 비우고 저장하면 해제" : "Tally 에서 발급한 API 키를 붙여넣는다"}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="예: tally_xxxxxxxx" aria-label="Tally API 키" style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-primary" onClick={saveApiKey} disabled={busy === "key"}>{busy === "key" ? "저장 중..." : "API 키 저장"}</button>
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 16 }}>
          <span className="b2b-field-label">2) 가져올 폼 {formId && <span className="opt">현재 {formId}</span>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="b2b-btn-secondary" onClick={loadForms} disabled={busy === "forms" || !hasApiKey}>{busy === "forms" ? "불러오는 중..." : "폼 불러오기"}</button>
            {!hasApiKey && !loading && <span className="b2b-btn-why">API 키를 저장하면 켜집니다</span>}
            {forms.length > 0 && (
              <select className="b2b-input" value={formId} onChange={(e) => selectForm(e.target.value)} style={{ flex: 1, minWidth: 240 }}>
                <option value="">폼 선택...</option>
                {forms.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.id})</option>)}
              </select>
            )}
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6 }}>
          <span className="b2b-field-label">3) 응답 가져오기</span>
          <div className="sm-row" style={{ gap: 8 }}>
            <button className="b2b-btn-primary" onClick={importNow} disabled={busy === "import" || !hasApiKey || !formId}>{busy === "import" ? "가져오는 중..." : "응답 가져오기"}</button>
            {!loading && (!hasApiKey || !formId) && <span className="b2b-btn-why">{!hasApiKey ? "API 키를 저장하면 켜집니다" : "가져올 폼을 고르면 켜집니다"}</span>}
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>이미 가져온 응답은 건너뜀, 첫 가져오기는 최근 60일</span>
        </div>
      </section>
    </div>
  );
}
