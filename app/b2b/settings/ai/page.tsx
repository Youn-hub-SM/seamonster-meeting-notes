"use client";

import { useEffect, useState } from "react";

type ModelKey = "haiku" | "sonnet" | "opus";
type FeatureVal = ModelKey | "inherit";
type Option = { key: ModelKey; label: string; desc: string; price: string };
type FeatureMeta = { key: string; label: string; desc: string };

const PROMPT_TEXTAREA: React.CSSProperties = {
  width: "100%",
  minHeight: 300,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12.5,
  lineHeight: 1.7,
  resize: "vertical",
  whiteSpace: "pre",
  overflowWrap: "normal",
  overflowX: "auto",
};

export default function AiSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 모델
  const [options, setOptions] = useState<Option[]>([]);
  const [featureMeta, setFeatureMeta] = useState<FeatureMeta[]>([]);
  const [global, setGlobal] = useState<ModelKey>("sonnet");
  const [features, setFeatures] = useState<Record<string, FeatureVal>>({});
  const [savingKey, setSavingKey] = useState<string>(""); // "global" | feature key

  // 프롬프트(회의록·CS)
  const [meetingPrompt, setMeetingPrompt] = useState("");
  const [meetingIsDefault, setMeetingIsDefault] = useState(true);
  const [meetingSaving, setMeetingSaving] = useState(false);
  const [meetingSaved, setMeetingSaved] = useState("");
  const [meetingDefault, setMeetingDefault] = useState("");

  const [csPrompt, setCsPrompt] = useState("");
  const [csIsDefault, setCsIsDefault] = useState(true);
  const [csSaving, setCsSaving] = useState(false);
  const [csSaved, setCsSaved] = useState("");
  const [csDefault, setCsDefault] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [modelRes, meetingRes, csRes] = await Promise.all([
          fetch("/api/b2b/settings/model", { cache: "no-store" }),
          fetch("/api/b2b/settings/meeting-prompt", { cache: "no-store" }),
          fetch("/api/b2b/settings/cs-prompt", { cache: "no-store" }),
        ]);
        const mj = await modelRes.json();
        if (!modelRes.ok || !mj.ok) throw new Error(mj.error || "조회 실패");
        setOptions(mj.options || []);
        setFeatureMeta(mj.featureMeta || []);
        setGlobal(mj.global);
        setFeatures(mj.features || {});
        const pj = await meetingRes.json();
        if (meetingRes.ok && pj.ok) { setMeetingPrompt(pj.prompt || ""); setMeetingDefault(pj.default || ""); setMeetingIsDefault(!!pj.isDefault); }
        const cj = await csRes.json();
        if (csRes.ok && cj.ok) { setCsPrompt(cj.prompt || ""); setCsDefault(cj.default || ""); setCsIsDefault(!!cj.isDefault); }
      } catch (e) {
        setError(e instanceof Error ? e.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  const globalLabel = options.find((o) => o.key === global)?.label ?? global;

  async function selectGlobal(key: ModelKey) {
    if (key === global || savingKey) return;
    const prev = global;
    setGlobal(key); setSavingKey("global"); setError("");
    try {
      const r = await fetch("/api/b2b/settings/model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "global", key }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
    } catch (e) { setGlobal(prev); setError(e instanceof Error ? e.message : "저장 오류"); }
    setSavingKey("");
  }

  async function selectFeature(feature: string, key: FeatureVal) {
    if (features[feature] === key || savingKey) return;
    const prev = features[feature];
    setFeatures((f) => ({ ...f, [feature]: key })); setSavingKey(feature); setError("");
    try {
      const r = await fetch("/api/b2b/settings/model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: feature, key }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
    } catch (e) { setFeatures((f) => ({ ...f, [feature]: prev })); setError(e instanceof Error ? e.message : "저장 오류"); }
    setSavingKey("");
  }

  async function savePrompt(kind: "meeting" | "cs", nextValue?: string) {
    const url = kind === "meeting" ? "/api/b2b/settings/meeting-prompt" : "/api/b2b/settings/cs-prompt";
    const body = nextValue !== undefined ? nextValue : (kind === "meeting" ? meetingPrompt : csPrompt);
    const setSaving = kind === "meeting" ? setMeetingSaving : setCsSaving;
    setSaving(true); setError("");
    try {
      const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: body }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      const d = new Date();
      const stamp = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 저장됨`;
      if (kind === "meeting") { setMeetingPrompt(j.prompt || ""); setMeetingIsDefault(!!j.isDefault); setMeetingSaved(stamp); }
      else { setCsPrompt(j.prompt || ""); setCsIsDefault(!!j.isDefault); setCsSaved(stamp); }
    } catch (e) { setError(e instanceof Error ? e.message : "프롬프트 저장 오류"); }
    setSaving(false);
  }

  function resetPrompt(kind: "meeting" | "cs") {
    const label = kind === "meeting" ? "회의록 정리 지침" : "CS 코치 지침";
    if (!confirm(`${label}을 기본값으로 되돌릴까요? 저장한 내용은 사라집니다.`)) return;
    if (kind === "meeting") setMeetingPrompt(meetingDefault); else setCsPrompt(csDefault);
    savePrompt(kind, ""); // 빈 값 → 기본값 복원
  }

  const featureOptions: { key: FeatureVal; label: string }[] = [
    { key: "inherit", label: "전체(공통) 따름" },
    ...options.map((o) => ({ key: o.key as FeatureVal, label: o.label })),
  ];

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">AI 설정</h1>
          <p className="b2b-page-subtitle">기능별 AI 모델과 프롬프트를 지정합니다. 코드 수정·재배포 없이 즉시 반영됩니다.</p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 공통 기본 모델 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">공통 기본 모델</h2>
          {savingKey === "global" && <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>적용 중...</span>}
        </div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px" }}>
          아래 기능별 설정이 <strong>‘전체(공통) 따름’</strong>일 때 사용되는 기본 모델입니다.
          (사업자등록증 OCR 은 정확도 위해 항상 Sonnet 사용)
        </p>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : (
          <div className="ai-model-grid">
            {options.map((opt) => (
              <button key={opt.key} type="button" className={`ai-model-card ${global === opt.key ? "is-active" : ""}`} onClick={() => selectGlobal(opt.key)} disabled={!!savingKey}>
                <div className="ai-model-label">{opt.label}{global === opt.key && <span className="ai-model-check">✓ 사용 중</span>}</div>
                <div className="ai-model-desc">{opt.desc}</div>
                <div className="ai-model-price">{opt.price} <span>/ 1M 토큰</span></div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 기능별 모델 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">기능별 모델</h2>
        </div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px" }}>
          각 기능이 쓸 모델을 개별 지정하거나 <strong>공통 기본({globalLabel})</strong>을 따르게 할 수 있습니다.
        </p>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {featureMeta.map((f, i) => (
              <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0", borderTop: i === 0 ? "none" : "1px solid var(--sm-border)", flexWrap: "wrap" }}>
                <div style={{ minWidth: 180 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--sm-dark)" }}>{f.label}</div>
                  <div style={{ fontSize: 12, color: "var(--sm-text-light)" }}>{f.desc}</div>
                </div>
                <select
                  className="b2b-select"
                  value={features[f.key] ?? "inherit"}
                  onChange={(e) => selectFeature(f.key, e.target.value as FeatureVal)}
                  disabled={savingKey === f.key}
                  style={{ maxWidth: 220 }}
                >
                  {featureOptions.map((o) => (
                    <option key={o.key} value={o.key}>{o.key === "inherit" ? `전체(공통) 따름 · 현재 ${globalLabel}` : o.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 회의록 정리 프롬프트 */}
      <PromptCard
        title="회의록 정리 프롬프트 (지침)"
        desc={<>회의 녹취를 정리하는 기초 지침입니다. <strong>팀원 정보·회사 맥락·출력 형식(JSON)</strong>은 시스템이 자동으로 덧붙이므로 여기에 넣지 마세요.</>}
        loading={loading} value={meetingPrompt} isDefault={meetingIsDefault} saving={meetingSaving} saved={meetingSaved}
        onChange={(v) => { setMeetingPrompt(v); setMeetingSaved(""); }}
        onSave={() => savePrompt("meeting")} onReset={() => resetPrompt("meeting")}
      />

      {/* CS 코치 프롬프트 */}
      <PromptCard
        title="CS 코치 프롬프트 (지침)"
        desc={<>CS 코치의 역할·코칭 방식·원칙을 정의합니다. <strong>매뉴얼 내용</strong>과 <strong>출력 형식(JSON)</strong>은 시스템이 자동으로 덧붙이므로 여기에 넣지 마세요 — 매뉴얼은 <a href="/cs/manual" style={{ color: "var(--sm-orange)", fontWeight: 600 }}>CS 매뉴얼</a>에서 관리합니다.</>}
        loading={loading} value={csPrompt} isDefault={csIsDefault} saving={csSaving} saved={csSaved}
        onChange={(v) => { setCsPrompt(v); setCsSaved(""); }}
        onSave={() => savePrompt("cs")} onReset={() => resetPrompt("cs")}
      />
    </>
  );
}

function PromptCard(props: {
  title: string; desc: React.ReactNode; loading: boolean; value: string; isDefault: boolean;
  saving: boolean; saved: string; onChange: (v: string) => void; onSave: () => void; onReset: () => void;
}) {
  return (
    <section className="b2b-card">
      <div className="b2b-card-head">
        <h2 className="b2b-card-title">{props.title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {props.saved && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{props.saved}</span>}
          <span style={{ fontSize: 11.5, color: props.isDefault ? "var(--sm-text-light)" : "var(--sm-orange)" }}>{props.isDefault ? "기본값" : "사용자 지정"}</span>
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 12px", lineHeight: 1.7 }}>{props.desc}</p>
      {props.loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          <textarea className="b2b-textarea" value={props.value} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} style={PROMPT_TEXTAREA} />
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="b2b-btn-primary" onClick={props.onSave} disabled={props.saving}>{props.saving ? "저장 중..." : "프롬프트 저장"}</button>
            <button className="b2b-btn-secondary" onClick={props.onReset} disabled={props.saving || props.isDefault}>기본값으로 복원</button>
            <span style={{ fontSize: 11.5, color: "var(--sm-text-light)" }}>{props.value.length.toLocaleString()}자 · 모든 사용자 공용</span>
          </div>
        </>
      )}
    </section>
  );
}
