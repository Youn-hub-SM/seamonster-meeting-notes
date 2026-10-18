"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NOTICE_CHANNELS,
  NOTICE_TYPES,
  NOTICE_VALUE_MAX,
  type NoticeFieldInfo,
  carryExtras,
  fieldInfo,
  findNoticeType,
  isNoticeFieldRequired,
  promptFieldsFor,
} from "@/app/lib/notice-types";
import { qty, qtyText } from "@/app/lib/format";

type Refine = "shorter" | "politer" | "compensation";
type Busy = "" | "make" | "remake" | "type" | "apply" | Refine;

// /api/notice 응답 중 화면이 쓰는 것. fields 는 AI 추출값(+직원 추가 입력), missing·optional 은 비어 있는 항목.
type Result = {
  type: string;
  typeLabel: string;
  fields: Record<string, string>;
  missing: NoticeFieldInfo[];
  optional: NoticeFieldInfo[];
  limit: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function NoticePage() {
  const [channel, setChannel] = useState<string>(NOTICE_CHANNELS[0]);
  const [text, setText] = useState("");
  // 직원이 항목에 넣은 값 = AI 추출값 위에 덮는 값. 결과가 있는 동안 누적되고, 맨 위 [공지 만들기](새 공지)에서 비운다.
  //  "" 는 '비웠다' 표시(화면·pending 용). 서버에는 carryExtras 가 빈 값·그 유형에 없는 키·kind 가 다른 키·선택지 밖 값을 걸러 보내고,
  //  응답이 오면 보낸 것만 남긴다.
  const [extras, setExtras] = useState<Record<string, string>>({});
  // 유형 select 에서 고른 값 — 응답 전까지 select 에 보여 준다(result.type 은 응답 뒤에야 바뀐다)
  const [pendingType, setPendingType] = useState<string | null>(null);

  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState("");
  const [promptDefault, setPromptDefault] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptMsg, setPromptMsg] = useState("");

  const typeDef = useMemo(() => (result ? findNoticeType(result.type) : null), [result]);
  const limit = result?.limit ?? 0;
  const count = draft.length;
  const over = limit > 0 && count > limit;

  // 값이 있는 항목(AI 추출·추가 입력·기본값) = missing·optional 에 없는 나머지. 고치거나 비울 수 있게 카드에 그린다.
  const filled = useMemo(() => {
    if (!result || !typeDef) return [] as { f: NoticeFieldInfo; required: boolean }[];
    const gap = new Set([...result.missing, ...result.optional].map((f) => f.key));
    return promptFieldsFor(typeDef)
      .filter((f) => !gap.has(f.key))
      .map((f) => ({ f: fieldInfo(f), required: isNoticeFieldRequired(f, result.fields) }));
  }, [result, typeDef]);

  // 서버가 마지막으로 돌려준 값과 다른 추가 입력이 하나라도 있어야 [반영해서 다시 만들기] 가 열린다.
  //  select 는 선택지 안의 값만 '넣은 것' 으로 본다(선택지 밖은 서버가 버려 바뀌는 게 없다).
  const pending = useMemo(() => {
    if (!result || !typeDef) return false;
    return promptFieldsFor(typeDef).some((f) => {
      const x = extras[f.key];
      if (x === undefined) return false;
      const v = x.trim();
      if (f.kind === "select" && v && !f.options?.includes(v)) return false;
      return v !== (result.fields[f.key] ?? "").trim();
    });
  }, [result, typeDef, extras]);

  const locked = busy !== "";           // 만드는 중 — 버튼·select·입력칸 잠금(글은 읽고 고칠 수 있게 textarea 는 두 개 다 둔다)
  const noText = !text.trim();          // 다듬기·다시 만들기도 [공지할 내용] 이 있어야 한다(서버가 다시 추출한다)

  // AI 호출 1회 — 유형 판단 + 항목 추출 + 초안. type 을 주면 그 유형으로 고정(유형 select·다듬기·반영·다시 만들기 때).
  //  추가 입력은 type 이 있을 때만 보낸다 — 새 공지(맨 위 [공지 만들기])는 이전 공지의 값을 비우고 처음부터.
  async function generate(opts: { busy: Busy; type?: string | null; refine?: Refine | null }) {
    if (locked) return;
    if (!text.trim()) return;
    if (opts.refine && !draft.trim()) return;
    const toType = opts.type ? findNoticeType(opts.type) : null;
    const sent = toType ? carryExtras(extras, typeDef, toType) : {};
    setBusy(opts.busy);
    setError("");
    setCopied(false);
    setCopyHint("");
    try {
      const res = await fetch("/api/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          text,
          type: opts.type ?? undefined,
          extras: Object.keys(sent).length > 0 ? sent : undefined,
          refine: opts.refine ?? undefined,
          previous: opts.refine ? draft : undefined, // 직원이 고친 글을 바탕으로 다듬는다
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "공지를 만들지 못했습니다. 내용을 확인하고 [공지 만들기]를 다시 누르세요");
      setResult({
        type: typeof j.type === "string" ? j.type : "general",
        typeLabel: typeof j.typeLabel === "string" ? j.typeLabel : "",
        fields: j.fields && typeof j.fields === "object" ? j.fields : {},
        missing: Array.isArray(j.missing) ? j.missing : [],
        optional: Array.isArray(j.optional) ? j.optional : [],
        limit: typeof j.limit === "number" ? j.limit : 0,
      });
      setDraft(typeof j.text === "string" ? j.text : "");
      setExtras(sent); // 서버가 받은 것만 남긴다 — 비운 값·다른 유형의 값은 여기서 정리된다
    } catch (e) {
      setError(e instanceof Error ? e.message : "공지를 만들지 못했습니다. 내용을 확인하고 [공지 만들기]를 다시 누르세요");
    } finally {
      setBusy("");
      setPendingType(null); // 실패해도 지운다 — select 가 result.type 으로 돌아가야 같은 유형을 다시 고를 수 있다(onChange)
    }
  }

  function setExtra(key: string, v: string) {
    setExtras((m) => ({ ...m, [key]: v }));
  }

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setCopyHint("");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      draftRef.current?.focus();
      draftRef.current?.select();
      setCopyHint("복사되지 않았습니다. 글이 선택되어 있으니 Ctrl+C 로 복사합니다.");
    }
  }

  // ── 톤 프롬프트 ──
  const loadPrompt = useCallback(async () => {
    try {
      const res = await fetch("/api/notice/prompt", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "프롬프트를 불러오지 못했습니다. 새로고침하세요");
      setPrompt(j.prompt || "");
      setPromptDefault(j.default || "");
      setPromptLoaded(true); // 성공했을 때만 편집·저장을 연다 — 조회 실패 뒤 빈 칸을 저장하면 남이 저장한 프롬프트가 지워진다
    } catch (e) {
      setPromptMsg(e instanceof Error ? e.message : "프롬프트를 불러오지 못했습니다. 새로고침하세요");
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
      if (!res.ok || !j.ok) throw new Error(j.error || "프롬프트를 저장하지 못했습니다. 내용을 확인하세요");
      setPrompt(j.prompt || "");
      setPromptMsg(j.isDefault ? "프롬프트를 저장했습니다 (기본값 사용 중)" : "프롬프트를 저장했습니다");
    } catch (e) {
      setPromptMsg(e instanceof Error ? e.message : "프롬프트를 저장하지 못했습니다. 내용을 확인하세요");
    } finally {
      setPromptSaving(false);
    }
  }

  const label = (b: Busy, text: string) => (busy === b ? "만드는 중..." : text);
  // 입력칸에 보이는 값 — 직원이 고친 값이 있으면 그것, 없으면 서버가 돌려준 값
  const gapValue = (f: NoticeFieldInfo) => extras[f.key] ?? result?.fields[f.key] ?? "";

  return (
    <div className="b2b-container ntc-page">
      <header className="b2b-page-head">
        <h1 className="b2b-page-title">공지 작성기</h1>
      </header>

      <div className="ntc-stack">
        <section className="b2b-form-section">
          <div className="ntc-form">
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="ntc-channel">채널</label>
              <select id="ntc-channel" className="b2b-input ntc-channel" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={locked}>
                {NOTICE_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="ntc-text">공지할 내용<span className="req">*</span></label>
              <textarea
                id="ntc-text"
                className="b2b-input b2b-textarea"
                rows={8}
                maxLength={NOTICE_VALUE_MAX}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          </div>
          <div className="ntc-foot">
            <button type="button" className="b2b-btn-primary" onClick={() => generate({ busy: "make" })} disabled={noText || locked}>
              {label("make", "공지 만들기")}
            </button>
            {noText && !locked && <span className="b2b-btn-why">공지할 내용을 넣으면 켜집니다</span>}
          </div>
        </section>

        {error && <div className="b2b-error">{error}</div>}

        {result !== null && (
          <>
            <div className="ntc-type">
              <span className="b2b-status-pill ntc-type-pill">{result.typeLabel}</span>
              <select
                className="b2b-input"
                aria-label="유형"
                value={pendingType ?? result.type}
                onChange={(e) => { setPendingType(e.target.value); generate({ busy: "type", type: e.target.value }); }}
                disabled={locked || noText}
              >
                {NOTICE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              {busy === "type" && <span className="sm-faint ntc-note">만드는 중...</span>}
            </div>

            <section className="b2b-card">
              <div className="b2b-card-head">
                <span className="b2b-card-title">공지문</span>
              </div>
              <textarea
                ref={draftRef}
                className="b2b-input b2b-textarea ntc-result"
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="ntc-foot">
                <span className={`sm-faint ntc-note ${over ? "is-over" : ""}`}>
                  글자 수 {qty(count)}{limit > 0 ? ` / 한도 ${qty(limit)}` : ""}
                </span>
                <div className="sm-row-wrap sm-gap-2">
                  <button type="button" className="b2b-btn-primary" onClick={copy} disabled={!draft || locked}>{copied ? "복사됨" : "공지 복사"}</button>
                  <button type="button" className="b2b-btn-secondary" onClick={() => generate({ busy: "shorter", type: result.type, refine: "shorter" })} disabled={locked || noText || !draft.trim()}>{label("shorter", "더 짧게")}</button>
                  <button type="button" className="b2b-btn-secondary" onClick={() => generate({ busy: "politer", type: result.type, refine: "politer" })} disabled={locked || noText || !draft.trim()}>{label("politer", "더 정중하게")}</button>
                  {typeDef?.apology && (
                    <button type="button" className="b2b-btn-secondary" onClick={() => generate({ busy: "compensation", type: result.type, refine: "compensation" })} disabled={locked || noText || !draft.trim()}>{label("compensation", "보상 강조")}</button>
                  )}
                  <button type="button" className="b2b-btn-secondary" onClick={() => generate({ busy: "remake", type: result.type })} disabled={locked || noText}>{label("remake", "다시 만들기")}</button>
                </div>
              </div>
              <p className="sm-faint ntc-note">다시 만들면 고친 글은 사라집니다</p>
              {copyHint && <p className="sm-faint ntc-note">{copyHint}</p>}
            </section>

            {/* 빠진 필수 항목 → 선택 항목 → 채워진 항목(수정·비움). 필수가 다 있어도 카드는 남는다 — 채워진 값을 고치는 자리라서. */}
            <section className="b2b-card ntc-gaps">
              <div className="b2b-card-head">
                <span className="b2b-card-title">추가로 넣으면 좋은 것</span>
              </div>
              {result.missing.length > 0 ? (
                <div className="ntc-grid">
                  {result.missing.map((f) => (
                    <GapField key={f.key} f={f} required value={gapValue(f)} disabled={locked} onChange={(v) => setExtra(f.key, v)} />
                  ))}
                </div>
              ) : (
                <div className="sm-success">필수 항목이 모두 있습니다</div>
              )}
              {result.optional.length > 0 && (
                <details className="ntc-fold">
                  <summary>선택 항목 {qtyText(result.optional.length)}</summary>
                  <div className="ntc-grid">
                    {result.optional.map((f) => (
                      <GapField key={f.key} f={f} required={false} value={gapValue(f)} disabled={locked} onChange={(v) => setExtra(f.key, v)} />
                    ))}
                  </div>
                </details>
              )}
              {filled.length > 0 && (
                <details className="ntc-fold">
                  <summary>채워진 항목 {qtyText(filled.length)}</summary>
                  <div className="ntc-grid">
                    {filled.map(({ f, required }) => (
                      <GapField key={f.key} f={f} required={required} value={gapValue(f)} disabled={locked} onChange={(v) => setExtra(f.key, v)} />
                    ))}
                  </div>
                </details>
              )}
              <div className="ntc-foot">
                <button type="button" className="b2b-btn-primary" onClick={() => generate({ busy: "apply", type: result.type })} disabled={!pending || locked || noText}>
                  {label("apply", "반영해서 다시 만들기")}
                </button>
              </div>
            </section>
          </>
        )}

        {/* 톤 프롬프트 — 매번 쓰는 게 아니라 접어 둔다(펼치면 다른 카드 제목과 같은 모양) */}
        <section className="b2b-card">
          <details className="ntc-prompt-fold">
            <summary>톤 프롬프트</summary>
            <textarea
              className="b2b-input b2b-textarea ntc-prompt"
              rows={16}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!promptLoaded || promptSaving}
            />
            <div className="ntc-foot">
              <button type="button" className="b2b-btn-primary" onClick={() => savePrompt()} disabled={!promptLoaded || promptSaving}>
                {promptSaving ? "저장 중..." : "프롬프트 저장"}
              </button>
              <button type="button" className="b2b-btn-secondary" onClick={() => savePrompt("")} disabled={!promptLoaded || promptSaving || (!!promptDefault && prompt === promptDefault)}>
                기본값으로 되돌리기
              </button>
              {promptMsg && <span className="sm-faint ntc-note">{promptMsg}</span>}
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}

// 항목 입력칸 — kind 에 맞는 input/select/date/textarea, hint 는 placeholder(입력 형식 예시). 빠진 항목·선택 항목·채워진 항목이 같이 쓴다.
function GapField({ f, value, required, disabled, onChange }: { f: NoticeFieldInfo; value: string; required: boolean; disabled: boolean; onChange: (v: string) => void }) {
  const id = `ntc-gap-${f.key}`;
  const wide = f.kind === "textarea";
  // AI 가 날짜를 YYYY-MM-DD 밖의 형태로 옮긴 값은 date 입력이 비워 보이므로 글자 입력으로 보여 준다
  const inputType = f.kind === "date" && value && !ISO_DATE.test(value) ? "text" : f.kind;
  return (
    <div className={`b2b-field ${wide ? "ntc-wide" : ""}`}>
      <label className="b2b-field-label" htmlFor={id}>
        {f.label}{required && <span className="req">*</span>}
      </label>
      {f.kind === "select" && (
        <select id={id} className="b2b-input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">선택</option>
          {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {f.kind === "textarea" && (
        <textarea id={id} className="b2b-input b2b-textarea" rows={3} maxLength={NOTICE_VALUE_MAX} value={value} placeholder={f.hint} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      )}
      {(f.kind === "text" || f.kind === "date" || f.kind === "number") && (
        <input id={id} className="b2b-input" type={inputType} maxLength={NOTICE_VALUE_MAX} value={value} placeholder={f.hint} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      )}
    </div>
  );
}
