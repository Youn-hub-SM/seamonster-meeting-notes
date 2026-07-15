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
  // flow(플로우) 연동
  const [hasFlowKey, setHasFlowKey] = useState(false);
  const [flowKey, setFlowKey] = useState("");
  const [flowProject, setFlowProject] = useState("");
  const [flowPriority, setFlowPriority] = useState("normal");
  const [flowWorker, setFlowWorker] = useState("");

  const webhookUrl = origin ? `${origin}/api/voc/tally` : "/api/voc/tally";

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/voc/tally-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      setHasApiKey(!!j.hasApiKey); setHasSecret(!!j.hasSecret); setFormId(j.formId || "");
    }).catch(() => {}).finally(() => setLoading(false));
    fetch("/api/voc/flow-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.ok) { setHasFlowKey(!!j.hasApiKey); setFlowProject(j.projectId || ""); setFlowPriority(j.priority || "normal"); setFlowWorker(j.worker || ""); }
    }).catch(() => {});
  }, []);

  async function saveFlow(body: Record<string, string>, okMsg: string, tag: string) {
    setBusy(tag); setMsg(null);
    try {
      const res = await fetch("/api/voc/flow-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMsg({ t: okMsg, ok: true });
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "저장 실패", ok: false }); }
    finally { setBusy(""); }
  }

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
          <p className="b2b-page-subtitle">Tally 설문 응답을 <a href="/voc/surveys" className="sm-link">설문 응답 수집</a>으로 가져옵니다(불만 클레임과 분리). 모든 질문·답변이 그대로 보존되고 사진도 함께 저장됩니다.</p>
        </div>
      </header>

      {msg && <div className={msg.ok ? "sm-success" : "b2b-error"}>{msg.t}</div>}

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

      {/* flow(플로우) 연동 — VOC 목록에서 '→ flow' 클릭 시 업무로 등록 */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">flow(플로우) 연동</span></div>
        <p className="sm-muted" style={{ fontSize: 13, marginBottom: 12 }}>
          VOC 목록/상세에서 <strong>→ flow</strong> 버튼으로 해당 VOC를 플로우 프로젝트의 <strong>업무(task)</strong>로 등록합니다. 먼저 플로우에서 <strong>알림봇</strong>을 만들어 프로젝트에 초대하고, 관리자 API 센터에서 <strong>API 키</strong>를 발급받으세요.
        </p>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">1) flow API 키 (x-flow-api-key) · 현재 {loading ? "확인 중…" : hasFlowKey ? <strong style={{ color: "var(--sm-success)" }}>저장됨</strong> : <strong style={{ color: "var(--sm-warning)" }}>미설정</strong>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="password" value={flowKey} onChange={(e) => setFlowKey(e.target.value)} placeholder={hasFlowKey ? "새 키로 변경(비우고 저장 시 해제)" : "API 센터에서 발급한 키 붙여넣기"} style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-primary" onClick={async () => { await saveFlow({ apiKey: flowKey }, flowKey.trim() ? "API 키 저장됨" : "API 키 해제됨", "flowkey"); setHasFlowKey(!!flowKey.trim()); setFlowKey(""); }} disabled={busy === "flowkey"}>{busy === "flowkey" ? "저장 중…" : "저장"}</button>
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">2) 기본 프로젝트 ID</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" value={flowProject} onChange={(e) => setFlowProject(e.target.value)} placeholder="예: 940907 (플로우 프로젝트 번호)" style={{ flex: 1, minWidth: 240 }} inputMode="numeric" />
            <button className="b2b-btn-secondary" onClick={() => saveFlow({ projectId: flowProject }, "프로젝트 ID 저장됨", "flowproj")} disabled={busy === "flowproj"}>{busy === "flowproj" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>플로우 프로젝트 URL/설정에서 확인. VOC는 이 프로젝트에 업무로 등록됩니다.</span>
        </div>

        <div className="sm-col" style={{ gap: 6 }}>
          <span className="b2b-field-label">3) 기본 우선순위</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select className="b2b-input" value={flowPriority} onChange={(e) => setFlowPriority(e.target.value)} style={{ width: "auto" }}>
              {["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button className="b2b-btn-secondary" onClick={() => saveFlow({ priority: flowPriority }, "우선순위 저장됨", "flowpri")} disabled={busy === "flowpri"}>{busy === "flowpri" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>업무 상태는 VOC 단계에 맞춰 자동(접수→request · 응대·개선중→progress · 개선완료→complete)으로 등록됩니다.</span>
        </div>

        <div className="sm-col" style={{ gap: 6, marginTop: 14 }}>
          <span className="b2b-field-label">4) 기본 담당자 (workerId · 이메일)</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="email" value={flowWorker} onChange={(e) => setFlowWorker(e.target.value)} placeholder="예: seamonster2016@naver.com (비우면 미지정)" style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-secondary" onClick={() => saveFlow({ worker: flowWorker }, flowWorker.trim() ? "기본 담당자 저장됨" : "기본 담당자 해제됨", "flowworker")} disabled={busy === "flowworker"}>{busy === "flowworker" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>등록되는 업무의 담당자로 지정됩니다. <strong>반드시 플로우 프로젝트의 멤버 이메일</strong>이어야 합니다(아니면 flow가 거부). VOC별로 다르게 하려면 개별 등록 시 지정할 수 있게 추후 확장 가능.</span>
        </div>
      </section>
    </div>
  );
}
