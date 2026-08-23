"use client";

import { useEffect, useState } from "react";

// VOC 연동 설정 — Tally(응답 가져오기) + 아사나(업무 등록).
//  2026-08-23 대청소: Tally 웹훅(대안)·flow(플로우) 연동 카드 제거 — flow 는 Teams+아사나로 전환 완료.
export default function VocSettingsPage() {
  const [loading, setLoading] = useState(true);
  // API(pull)
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [formId, setFormId] = useState("");
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  // 아사나 연동 — 설정이 완료되면 VOC 화면에 '→ 아사나' 버튼이 나타난다
  const [hasAsanaPat, setHasAsanaPat] = useState(false);
  const [asanaPat, setAsanaPat] = useState("");
  const [asanaProject, setAsanaProject] = useState("");
  const [asanaAssignee, setAsanaAssignee] = useState("");

  useEffect(() => {
    fetch("/api/voc/tally-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      setHasApiKey(!!j.hasApiKey); setFormId(j.formId || "");
    }).catch(() => {}).finally(() => setLoading(false));
    fetch("/api/voc/asana-config", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.ok) { setHasAsanaPat(!!j.hasPat); setAsanaProject(j.project || ""); setAsanaAssignee(j.assignee || ""); }
    }).catch(() => {});
  }, []);

  // 결과는 아사나 카드 안에 표시(전역 배너는 페이지 맨 위라 카드에서 안 보인다)
  const [asanaMsg, setAsanaMsg] = useState<{ t: string; ok: boolean } | null>(null);
  async function saveAsana(body: Record<string, string | boolean>, okMsg: string, tag: string) {
    setBusy(tag); setAsanaMsg(null);
    try {
      const res = await fetch("/api/voc/asana-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({ ok: false, error: `서버 응답 오류(HTTP ${res.status})` }));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setAsanaMsg({ t: j.detail || okMsg, ok: true });
      if (typeof j.project === "string" && j.project) setAsanaProject(j.project);
    } catch (e) { setAsanaMsg({ t: e instanceof Error ? e.message : "저장 실패", ok: false }); }
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

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · VOC 연동</h1>
        </div>
      </header>

      {msg && <div className={msg.ok ? "sm-success" : "b2b-error"}>{msg.t}</div>}

      {/* API 키 방식(권장) */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">Tally API 연동</span></div>

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

      {/* 아사나 연동 — 설정 완료 시 VOC 화면에 '→ 아사나' 버튼이 나타난다 */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">아사나(Asana) 연동</span></div>
        <p className="sm-muted" style={{ fontSize: 15, marginBottom: 12 }}>
          VOC 목록/상세에서 <strong>→ 아사나</strong> 버튼으로 해당 VOC를 아사나 프로젝트의 <strong>업무(task)</strong>로 등록합니다.
          PAT와 프로젝트가 모두 저장되면 VOC 화면에 버튼이 나타납니다.
          토큰 발급: 아사나 <strong>내 설정 → 앱 → 개발자 앱 관리 → 개인 액세스 토큰(PAT) 만들기</strong>.
        </p>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">1) 개인 액세스 토큰(PAT) · 현재 {loading ? "확인 중…" : hasAsanaPat ? <strong style={{ color: "var(--sm-success)" }}>저장됨</strong> : <strong style={{ color: "var(--sm-warning)" }}>미설정</strong>}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="password" value={asanaPat} onChange={(e) => setAsanaPat(e.target.value)} placeholder={hasAsanaPat ? "새 토큰으로 변경(비우고 저장 시 해제)" : "아사나에서 발급한 PAT 붙여넣기"} style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-primary" onClick={async () => { await saveAsana({ pat: asanaPat }, asanaPat.trim() ? "PAT 저장됨" : "PAT 해제됨", "asanapat"); setHasAsanaPat(!!asanaPat.trim()); setAsanaPat(""); }} disabled={busy === "asanapat"}>{busy === "asanapat" ? "저장 중…" : "저장"}</button>
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">2) 프로젝트 (URL 또는 gid)</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" value={asanaProject} onChange={(e) => setAsanaProject(e.target.value)} placeholder="아사나에서 프로젝트를 연 상태의 주소를 그대로 붙여넣기" style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-secondary" onClick={() => saveAsana({ project: asanaProject }, "프로젝트 저장됨", "asanaproj")} disabled={busy === "asanaproj"}>{busy === "asanaproj" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>URL을 넣으면 프로젝트 번호(gid)만 추려 저장합니다. 등록되는 업무는 VOC 상태와 무관하게 항상 '개선요청' 섹션에 들어갑니다(이후 상태 관리는 아사나에서).</span>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">3) 기본 담당자 (이메일 · 선택)</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="b2b-input" type="email" value={asanaAssignee} onChange={(e) => setAsanaAssignee(e.target.value)} placeholder="아사나 워크스페이스 멤버 이메일 (비우면 미지정)" style={{ flex: 1, minWidth: 240 }} />
            <button className="b2b-btn-secondary" onClick={() => saveAsana({ assignee: asanaAssignee }, asanaAssignee.trim() ? "기본 담당자 저장됨" : "기본 담당자 해제됨", "asanaassignee")} disabled={busy === "asanaassignee"}>{busy === "asanaassignee" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>등록되는 업무의 담당자로 지정됩니다. 멤버가 아니면 담당자 없이 등록되고 안내가 표시됩니다.</span>
        </div>

        <div className="sm-row" style={{ gap: 8 }}>
          <button className="b2b-btn-secondary" onClick={() => saveAsana({ test: true }, "연결 OK", "asanatest")} disabled={busy === "asanatest"}>{busy === "asanatest" ? "확인 중…" : "연결 테스트"}</button>
          <span className="sm-faint" style={{ fontSize: 12, alignSelf: "center" }}>저장된 토큰으로 내 계정과 프로젝트 접근을 확인합니다.</span>
        </div>
        {asanaMsg && <div className={asanaMsg.ok ? "sm-success" : "b2b-error"} style={{ marginTop: 10 }}>{asanaMsg.t}</div>}
      </section>
    </div>
  );
}
