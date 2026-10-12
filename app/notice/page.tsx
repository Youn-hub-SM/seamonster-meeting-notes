"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COMMON_KEYS,
  NOTICE_TYPES,
  NOTICE_VALUE_MAX,
  channelLimit,
  defaultValuesFor,
  fieldsFor,
  isNoticeFieldRequired,
  missingRequired,
  type NoticeField,
  type NoticeType,
  type NoticeValues,
} from "@/app/lib/notice-types";

type Refine = "shorter" | "politer" | "compensation";
type Busy = "" | "make" | Refine;

// 공통 항목(COMMON_KEYS: 채널·문의처·발신명·대상)은 유형을 바꿔도 공유, 유형 항목은 유형별로 따로 기억한다.
function initialCommon(): NoticeValues {
  const out: NoticeValues = {};
  for (const t of NOTICE_TYPES) for (const [k, v] of Object.entries(defaultValuesFor(t))) if (COMMON_KEYS.has(k)) out[k] = v;
  return out;
}
function initialByType(): Record<string, NoticeValues> {
  const out: Record<string, NoticeValues> = {};
  for (const t of NOTICE_TYPES) {
    const d: NoticeValues = {};
    for (const [k, v] of Object.entries(defaultValuesFor(t))) if (!COMMON_KEYS.has(k)) d[k] = v;
    out[t.key] = d;
  }
  return out;
}

export default function NoticePage() {
  const [typeKey, setTypeKey] = useState<string>(NOTICE_TYPES[0].key);
  const [common, setCommon] = useState<NoticeValues>(initialCommon);
  const [byType, setByType] = useState<Record<string, NoticeValues>>(initialByType);

  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState("");
  const resultRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState("");
  const [promptDefault, setPromptDefault] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptMsg, setPromptMsg] = useState("");

  const type: NoticeType = useMemo(() => NOTICE_TYPES.find((t) => t.key === typeKey) ?? NOTICE_TYPES[0], [typeKey]);
  const values: NoticeValues = useMemo(() => ({ ...common, ...(byType[typeKey] ?? {}) }), [common, byType, typeKey]);
  const fields = useMemo(() => fieldsFor(type), [type]);
  const missing = useMemo(() => missingRequired(type, values).length, [type, values]);

  const limit = channelLimit(values.channel);
  const count = result ? result.length : 0;
  const over = limit > 0 && count > limit;

  function setValue(key: string, v: string) {
    if (COMMON_KEYS.has(key)) setCommon((c) => ({ ...c, [key]: v }));
    else setByType((m) => ({ ...m, [typeKey]: { ...(m[typeKey] ?? {}), [key]: v } }));
  }

  // 만드는 중에는 유형을 바꾸지 않는다 — 늦게 온 응답이 다른 유형 탭 아래 결과로 들어가는 것을 막는다(탭 버튼도 disabled).
  function pickType(k: string) {
    if (busy) return;
    if (k === typeKey) return;
    setTypeKey(k);
    setResult(null);
    setError("");
    setCopied(false);
    setCopyHint("");
  }

  async function generate(refine: Refine | null) {
    if (busy) return;
    if (refine && !result) return;
    setBusy(refine ?? "make");
    setError("");
    setCopied(false);
    setCopyHint("");
    try {
      const res = await fetch("/api/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: typeKey, values, refine, previous: refine ? result : undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "공지 생성 실패");
      setResult(typeof j.text === "string" ? j.text : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "공지 생성 중 오류");
    } finally {
      setBusy("");
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setCopyHint("");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      resultRef.current?.focus();
      resultRef.current?.select();
      setCopyHint("복사되지 않았습니다. 글이 선택되어 있으니 Ctrl+C 로 복사합니다.");
    }
  }

  // ── 톤 프롬프트 ──
  const loadPrompt = useCallback(async () => {
    try {
      const res = await fetch("/api/notice/prompt", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "프롬프트 조회 실패");
      setPrompt(j.prompt || "");
      setPromptDefault(j.default || "");
      setPromptLoaded(true); // 성공했을 때만 편집·저장을 연다 — 조회 실패 뒤 빈 칸을 저장하면 남이 저장한 프롬프트가 지워진다
    } catch (e) {
      setPromptMsg(e instanceof Error ? e.message : "프롬프트 조회 실패");
    }
  }, []);
  useEffect(() => { loadPrompt(); }, [loadPrompt]);

  async function savePrompt(next?: string) {
    if (promptSaving || !promptLoaded || !promptDefault) return;
    setPromptSaving(true);
    setPromptMsg("");
    try {
      const res = await fetch("/api/notice/prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: next !== undefined ? next : prompt }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setPrompt(j.prompt || "");
      setPromptMsg(j.isDefault ? "저장됨 · 기본값 사용 중" : "저장됨");
    } catch (e) {
      setPromptMsg(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setPromptSaving(false);
    }
  }

  const refineLabel = (r: Refine, label: string) => (busy === r ? "만드는 중..." : label);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <h1 className="b2b-page-title">공지 작성기</h1>
      </header>

      <div className="ntc-stack">
        <div className="sm-tabs">
          {NOTICE_TYPES.map((t) => (
            <button key={t.key} type="button" className={`sm-tab ${t.key === typeKey ? "is-active" : ""}`} onClick={() => pickType(t.key)} disabled={busy !== ""}>
              {t.label}
            </button>
          ))}
        </div>

        <section className="b2b-form-section">
          <div className="ntc-grid">
            {fields.map((f) => (
              <FieldView key={f.key} f={f} value={values[f.key] ?? ""} required={isNoticeFieldRequired(f, values)} onChange={(v) => setValue(f.key, v)} />
            ))}
          </div>
          <div className="ntc-foot">
            <button type="button" className="b2b-btn-primary" onClick={() => generate(null)} disabled={missing > 0 || busy !== ""}>
              {busy === "make" ? "만드는 중..." : "공지 만들기"}
            </button>
            {missing > 0 && <span className="sm-faint ntc-note">필수 {missing}개 남음</span>}
          </div>
        </section>

        {error && <div className="b2b-error">{error}</div>}

        {result !== null && (
          <section className="b2b-card">
            <div className="b2b-card-head">
              <span className="b2b-card-title">공지문</span>
            </div>
            <textarea
              ref={resultRef}
              className="b2b-input b2b-textarea ntc-result"
              rows={12}
              value={result}
              onChange={(e) => setResult(e.target.value)}
            />
            <div className="ntc-foot">
              <span className={`sm-faint ntc-note ${over ? "is-over" : ""}`}>
                글자 수 {count.toLocaleString()}{limit > 0 ? ` / 한도 ${limit.toLocaleString()}` : ""}
              </span>
              <div className="sm-row-wrap sm-gap-2">
                <button type="button" className="b2b-btn-primary" onClick={copy} disabled={!result}>{copied ? "복사됨" : "복사"}</button>
                <button type="button" className="b2b-btn-secondary" onClick={() => generate("shorter")} disabled={busy !== ""}>{refineLabel("shorter", "더 짧게")}</button>
                <button type="button" className="b2b-btn-secondary" onClick={() => generate("politer")} disabled={busy !== ""}>{refineLabel("politer", "더 정중하게")}</button>
                {type.apology && (
                  <button type="button" className="b2b-btn-secondary" onClick={() => generate("compensation")} disabled={busy !== ""}>{refineLabel("compensation", "보상 강조")}</button>
                )}
                <button type="button" className="b2b-btn-secondary" onClick={() => generate(null)} disabled={missing > 0 || busy !== ""}>{busy === "make" ? "만드는 중..." : "다시 만들기"}</button>
              </div>
            </div>
            {copyHint && <p className="sm-faint ntc-note">{copyHint}</p>}
          </section>
        )}

        <section className="b2b-card">
          <div className="b2b-card-head">
            <span className="b2b-card-title">톤 프롬프트</span>
          </div>
          <textarea
            className="b2b-input b2b-textarea ntc-prompt"
            rows={16}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!promptLoaded || promptSaving}
          />
          <div className="ntc-foot">
            <button type="button" className="b2b-btn-primary" onClick={() => savePrompt()} disabled={!promptLoaded || promptSaving}>
              {promptSaving ? "저장 중..." : "저장"}
            </button>
            <button type="button" className="b2b-btn-secondary" onClick={() => savePrompt("")} disabled={!promptLoaded || promptSaving || (!!promptDefault && prompt === promptDefault)}>
              기본값으로
            </button>
            {promptMsg && <span className="sm-faint ntc-note">{promptMsg}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

function FieldView({ f, value, required, onChange }: { f: NoticeField; value: string; required: boolean; onChange: (v: string) => void }) {
  const wide = f.kind === "textarea";
  return (
    <div className={`b2b-field ${wide ? "ntc-wide" : ""}`}>
      <label className="b2b-field-label" htmlFor={`ntc-${f.key}`}>
        {f.label}{required && <span className="req">*</span>}
      </label>
      {f.kind === "select" && (
        <select id={`ntc-${f.key}`} className="b2b-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">선택</option>
          {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {f.kind === "textarea" && (
        <textarea id={`ntc-${f.key}`} className="b2b-input b2b-textarea" rows={3} maxLength={NOTICE_VALUE_MAX} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {(f.kind === "text" || f.kind === "date" || f.kind === "number") && (
        <input id={`ntc-${f.key}`} className="b2b-input" type={f.kind} maxLength={NOTICE_VALUE_MAX} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {f.hint && <span className="sm-faint ntc-note">{f.hint}</span>}
    </div>
  );
}
