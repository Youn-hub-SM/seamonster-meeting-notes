"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { qtyText } from "@/app/lib/format";

type ModelKey = "haiku" | "sonnet" | "opus" | "fable";
type FeatureVal = ModelKey | "inherit";
type Option = { key: ModelKey; label: string; price: string };
type FeatureMeta = { key: string; label: string; inheritDefault?: ModelKey };

const PROMPT_TEXTAREA: React.CSSProperties = {
  width: "100%",
  minHeight: 300,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.7,
  resize: "vertical",
  whiteSpace: "pre",
  overflowWrap: "normal",
  overflowX: "auto",
};

export default function AiSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const toast = useToast();

  // 모델
  const [options, setOptions] = useState<Option[]>([]);
  const [featureMeta, setFeatureMeta] = useState<FeatureMeta[]>([]);
  const [global, setGlobal] = useState<ModelKey>("sonnet");
  const [features, setFeatures] = useState<Record<string, FeatureVal>>({});
  const [savingKey, setSavingKey] = useState<string>(""); // "global" | feature key
  // 주간 생산 요청서 AI 초안의 'AI 검토 포인트'(Claude 호출) 켜기/끄기 — 꺼도 초안(수식 수량)은 만들어진다
  const [draftAi, setDraftAi] = useState<boolean | null>(null);
  const [draftAiSaving, setDraftAiSaving] = useState(false);
  useEffect(() => {
    fetch("/api/b2b/settings/draft-ai", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setDraftAi(!!j.enabled); }).catch(() => {});
  }, []);
  async function toggleDraftAi(next: boolean) {
    setDraftAiSaving(true);
    try {
      const j = await (await fetch("/api/b2b/settings/draft-ai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) })).json();
      if (!j.ok) throw new Error(j.error || "설정을 저장하지 못했습니다. 새로고침한 뒤 다시 하세요");
      setDraftAi(!!j.enabled);
    } catch (e) { setError(e instanceof Error ? e.message : "설정을 저장하지 못했습니다. 새로고침한 뒤 다시 하세요"); }
    setDraftAiSaving(false);
  }

  // AI 데이터 비서(/report) — 켜기/끄기 + 월 비용 상한(USD) + 이달 사용량. GET/PUT /api/b2b/settings/assistant
  const [asst, setAsst] = useState<{ off: boolean; capUsd: number; month: { ym: string; usd: number; questions: number } } | null>(null);
  const [asstCap, setAsstCap] = useState("");
  const [asstCapErr, setAsstCapErr] = useState("");
  const [asstSaving, setAsstSaving] = useState(false);
  // 신뢰·피드백(2026-10-19 개선안 5) — 30일 맞아요/틀려요 집계 + 최근 '틀려요' 사유. GET /api/report/feedback?stats=1
  const [fb, setFb] = useState<{ good: number; bad: number; recentBad: { id: string; user_name: string; note: string; created_at: string }[] } | null>(null);
  // 조회 범위 점검(2026-10-20 차단 목록 방식) — 보이는 표 수, 설명 없는 표, 설명 없는 jsonb, 개인정보 의심 컬럼. GET /api/report/schema-audit
  const [audit, setAudit] = useState<{ fromDb: boolean; visible: number; noComment: string[]; jsonbNoComment: string[]; pii: { table: string; column: string }[] } | null>(null);
  useEffect(() => {
    fetch("/api/report/schema-audit", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setAudit({ fromDb: j.fromDb, visible: j.visible, noComment: j.noComment || [], jsonbNoComment: j.jsonbNoComment || [], pii: j.pii || [] }); }).catch(() => {});
  }, []);
  useEffect(() => {
    fetch("/api/report/feedback?stats=1", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setFb({ good: j.good, bad: j.bad, recentBad: j.recentBad || [] }); }).catch(() => {});
  }, []);
  useEffect(() => {
    fetch("/api/b2b/settings/assistant", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j?.ok) return;
      setAsst({ off: !!j.off, capUsd: Number(j.capUsd) || 0, month: { ym: j.month?.ym || "", usd: Number(j.month?.usd) || 0, questions: Number(j.month?.questions) || 0 } });
      setAsstCap(String(Number(j.capUsd) || 0));
    }).catch(() => {});
  }, []);
  async function saveAssistant(patch: { off?: boolean; capUsd?: number }) {
    if (!asst) return;
    setAsstSaving(true); setError("");
    try {
      const j = await (await fetch("/api/b2b/settings/assistant", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })).json();
      if (!j.ok) throw new Error(j.error || "AI 데이터 비서 설정을 저장하지 못했습니다. 새로고침한 뒤 다시 하세요");
      setAsst((a) => a ? { ...a, off: patch.off ?? a.off, capUsd: patch.capUsd ?? a.capUsd } : a);
      toast.success("AI 데이터 비서 설정을 저장했습니다");
    } catch (e) { setError(e instanceof Error ? e.message : "AI 데이터 비서 설정을 저장하지 못했습니다. 새로고침한 뒤 다시 하세요"); }
    setAsstSaving(false);
  }
  function saveAssistantCap() {
    const n = Number(asstCap);
    if (asstCap.trim() === "" || Number.isNaN(n)) { setAsstCapErr("월 상한을 입력하세요"); return; }
    if (n < 0) { setAsstCapErr("0 이상"); return; }
    setAsstCapErr("");
    saveAssistant({ capUsd: n });
  }

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
        if (!modelRes.ok || !mj.ok) throw new Error(mj.error || "설정을 불러오지 못했습니다. 새로고침하세요");
        setOptions(mj.options || []);
        setFeatureMeta(mj.featureMeta || []);
        setGlobal(mj.global);
        setFeatures(mj.features || {});
        const pj = await meetingRes.json();
        if (meetingRes.ok && pj.ok) { setMeetingPrompt(pj.prompt || ""); setMeetingDefault(pj.default || ""); setMeetingIsDefault(!!pj.isDefault); }
        const cj = await csRes.json();
        if (csRes.ok && cj.ok) { setCsPrompt(cj.prompt || ""); setCsDefault(cj.default || ""); setCsIsDefault(!!cj.isDefault); }
      } catch (e) {
        setError(e instanceof Error ? e.message : "설정을 불러오지 못했습니다. 새로고침하세요");
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
      if (!r.ok || !j.ok) throw new Error(j.error || "모델을 저장하지 못했습니다. 다시 고르세요");
    } catch (e) { setGlobal(prev); setError(e instanceof Error ? e.message : "모델을 저장하지 못했습니다. 다시 고르세요"); }
    setSavingKey("");
  }

  async function selectFeature(feature: string, key: FeatureVal) {
    if (features[feature] === key || savingKey) return;
    const prev = features[feature];
    setFeatures((f) => ({ ...f, [feature]: key })); setSavingKey(feature); setError("");
    try {
      const r = await fetch("/api/b2b/settings/model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: feature, key }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "모델을 저장하지 못했습니다. 다시 고르세요");
    } catch (e) { setFeatures((f) => ({ ...f, [feature]: prev })); setError(e instanceof Error ? e.message : "모델을 저장하지 못했습니다. 다시 고르세요"); }
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
      if (!r.ok || !j.ok) throw new Error(j.error || "프롬프트를 저장하지 못했습니다. 내용을 확인하세요");
      const d = new Date();
      const stamp = `프롬프트를 저장했습니다 (${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")})`;
      if (kind === "meeting") { setMeetingPrompt(j.prompt || ""); setMeetingIsDefault(!!j.isDefault); setMeetingSaved(stamp); }
      else { setCsPrompt(j.prompt || ""); setCsIsDefault(!!j.isDefault); setCsSaved(stamp); }
    } catch (e) { setError(e instanceof Error ? e.message : "프롬프트를 저장하지 못했습니다. 내용을 확인하세요"); }
    setSaving(false);
  }

  // 기본값 복원 — 확인창 없이 바로 반영하고 되돌리기 토스트(이전 지침을 같은 저장 호출로 다시 저장)
  async function resetPrompt(kind: "meeting" | "cs") {
    const label = kind === "meeting" ? "회의록 정리 지침" : "CS 코치 지침";
    const prev = kind === "meeting" ? meetingPrompt : csPrompt;
    if (kind === "meeting") setMeetingPrompt(meetingDefault); else setCsPrompt(csDefault);
    await savePrompt(kind, ""); // 빈 값 → 기본값 복원
    toast.undo(`${label}을 기본값으로 복원했습니다`, async () => {
      if (kind === "meeting") setMeetingPrompt(prev); else setCsPrompt(prev);
      await savePrompt(kind, prev);
    });
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
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 공통 기본 모델 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">공통 기본 모델</h2>
          {savingKey === "global" && <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>적용 중...</span>}
        </div>
        {loading ? <div className="b2b-loading">불러오는 중...</div> : (
          <div className="ai-model-grid">
            {options.map((opt) => (
              <button key={opt.key} type="button" className={`ai-model-card ${global === opt.key ? "is-active" : ""}`} onClick={() => selectGlobal(opt.key)} disabled={!!savingKey}>
                <div className="ai-model-label">{opt.label}{global === opt.key && <span className="ai-model-check">✓ 사용 중</span>}</div>
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
        {loading ? <div className="b2b-loading">불러오는 중...</div> : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {featureMeta.map((f, i) => (
              <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0", borderTop: i === 0 ? "none" : "1px solid var(--sm-border)", flexWrap: "wrap" }}>
                <div style={{ minWidth: 180 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--sm-dark)" }}>{f.label}</div>
                </div>
                <select
                  className="b2b-select"
                  value={features[f.key] ?? "inherit"}
                  onChange={(e) => selectFeature(f.key, e.target.value as FeatureVal)}
                  disabled={savingKey === f.key}
                  style={{ maxWidth: 220 }}
                >
                  {featureOptions.map((o) => (
                    <option key={o.key} value={o.key}>{o.key !== "inherit" ? o.label
                      : f.inheritDefault ? `기본 (${options.find((x) => x.key === f.inheritDefault)?.label ?? f.inheritDefault})` // 공통 대신 이 기능의 기본 모델로 돈다(리포트·이익률 등)
                      : `전체(공통) 따름 (현재 ${globalLabel})`}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 주간 생산 요청서 초안 — 검토 포인트 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">생산 요청서 초안 검토 포인트</h2>
        </div>
        {draftAi === null ? <div className="b2b-loading">불러오는 중...</div> : (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" className="b2b-checkbox" checked={draftAi} disabled={draftAiSaving} onChange={(e) => toggleDraftAi(e.target.checked)} />
            AI 검토 포인트 붙이기
          </label>
        )}
      </section>

      {/* AI 데이터 비서 — 켜기/끄기 · 월 비용 상한 · 이달 사용 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">AI 데이터 비서</h2>
          {asst && <span className="b2b-field-hint">이달 사용 {qtyText(asst.month.questions, "건")} · 약 ${asst.month.usd.toFixed(2)}</span>}
        </div>
        {asst === null ? <div className="b2b-loading">불러오는 중...</div> : (
          <div className="sm-col" style={{ gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" className="b2b-checkbox" checked={!asst.off} disabled={asstSaving} onChange={(e) => saveAssistant({ off: !e.target.checked })} />
              AI 데이터 비서 켜기
            </label>
            <div className="b2b-field" style={{ maxWidth: 320 }}>
              <span className="b2b-field-label">월 상한(USD) <span className="opt">넘으면 빠른 모델로 답한다</span></span>
              <div className="sm-row" style={{ gap: 8 }}>
                <input className="b2b-input" type="number" min={0} step={1} value={asstCap} aria-label="월 상한(USD)" aria-invalid={asstCapErr ? "true" : undefined}
                  onChange={(e) => { setAsstCap(e.target.value); if (asstCapErr) setAsstCapErr(""); }} />
                <button className="b2b-btn-primary" onClick={saveAssistantCap} disabled={asstSaving}>{asstSaving ? "저장 중..." : "변경 저장"}</button>
              </div>
              {asstCapErr && <span className="b2b-field-error">{asstCapErr}</span>}
            </div>
          </div>
        )}
      </section>

      {/* AI 데이터 비서 — 답 피드백 30일(개선안 5) */}
      {fb && (
        <section className="b2b-card">
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">AI 데이터 비서 피드백 (30일)</h2>
            <span className="b2b-field-hint">맞아요 {qtyText(fb.good, "건")} · 틀려요 {qtyText(fb.bad, "건")}</span>
          </div>
          {fb.recentBad.length === 0 ? <div className="b2b-empty">'틀려요' 사유가 아직 없습니다.</div> : (
            <ul className="rp-list">
              {fb.recentBad.map((r) => <li key={r.id}>{r.note} <span className="sm-faint">· {r.user_name} · {String(r.created_at).slice(0, 10)}</span></li>)}
            </ul>
          )}
        </section>
      )}

      {/* AI 데이터 비서 — 조회 범위 점검(차단 목록 방식) */}
      {audit && (
        <section className="b2b-card">
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">AI 데이터 비서 조회 범위</h2>
            <span className="b2b-field-hint">보이는 표·뷰 {qtyText(audit.visible, "개")}{audit.fromDb ? "" : " · DB 주석 조회 실패(손 설명으로 동작)"}</span>
          </div>
          {audit.pii.length > 0 && (
            <div className="sm-warn">개인정보·비밀로 의심되는 컬럼이 차단되지 않은 표에 있습니다 — 확인하고 필요하면 BLOCKED_RELATIONS 에 넣으세요: {audit.pii.map((p) => `${p.table}.${p.column}`).join(", ")}</div>
          )}
          <ul className="rp-list" style={{ marginTop: 8 }}>
            <li>설명(주석) 없는 표 {qtyText(audit.noComment.length, "개")}{audit.noComment.length ? `: ${audit.noComment.slice(0, 12).join(", ")}${audit.noComment.length > 12 ? " …" : ""}` : ""}</li>
            <li>설명 없는 jsonb 컬럼 {qtyText(audit.jsonbNoComment.length, "개")}{audit.jsonbNoComment.length ? `: ${audit.jsonbNoComment.slice(0, 12).join(", ")}${audit.jsonbNoComment.length > 12 ? " …" : ""}` : ""} — 주석이 없으면 비서가 그 안의 값을 풀어 보지 못합니다</li>
          </ul>
        </section>
      )}

      {/* 회의록 정리 프롬프트 */}
      <PromptCard
        title="회의록 정리 프롬프트 (지침)"
        desc={<><strong>팀원 정보·회사 맥락·출력 형식(JSON)</strong>은 자동으로 덧붙습니다 — 넣지 마세요.</>}
        loading={loading} value={meetingPrompt} isDefault={meetingIsDefault} saving={meetingSaving} saved={meetingSaved}
        onChange={(v) => { setMeetingPrompt(v); setMeetingSaved(""); }}
        onSave={() => savePrompt("meeting")} onReset={() => resetPrompt("meeting")}
      />

      {/* CS 코치 프롬프트 */}
      <PromptCard
        title="CS 코치 프롬프트 (지침)"
        desc={<><strong>매뉴얼 내용·출력 형식(JSON)</strong>은 자동으로 덧붙습니다 — 넣지 마세요.</>}
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
          <span style={{ fontSize: 12, color: props.isDefault ? "var(--sm-text-light)" : "var(--sm-orange)" }}>{props.isDefault ? "기본값" : "사용자 지정"}</span>
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 12px", lineHeight: 1.7 }}>{props.desc}</p>
      {props.loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          <textarea className="b2b-textarea" value={props.value} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} style={PROMPT_TEXTAREA} />
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="b2b-btn-primary" onClick={props.onSave} disabled={props.saving}>{props.saving ? "저장 중..." : "프롬프트 저장"}</button>
            <button className="b2b-btn-secondary" onClick={props.onReset} disabled={props.saving || props.isDefault}>기본값으로 복원</button>
            <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>{qtyText(props.value.length, "자")}, 모든 사용자 공용</span>
          </div>
        </>
      )}
    </section>
  );
}
