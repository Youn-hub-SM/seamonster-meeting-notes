"use client";

import { useMemo, useState } from "react";
import { COUPON_CHANNELS, buildRequestText, isFieldShown, type CouponChannel, type CouponField, type Answers } from "@/app/lib/coupon-form";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function defaultsFor(ch: CouponChannel): Answers {
  const a: Answers = {};
  for (const s of ch.steps) for (const f of s.fields) if (f.default !== undefined) a[f.key] = f.default;
  return a;
}

export default function CouponPage() {
  const [channelKey, setChannelKey] = useState<string>("");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [requester, setRequester] = useState("");
  const [copied, setCopied] = useState(false);

  const channel = useMemo(() => COUPON_CHANNELS.find((c) => c.key === channelKey) || null, [channelKey]);
  const totalSteps = channel ? channel.steps.length : 0;
  const isReview = !!channel && step >= totalSteps;

  function pickChannel(k: string) { setChannelKey(k); setStep(0); const ch = COUPON_CHANNELS.find((c) => c.key === k); setAnswers(ch ? defaultsFor(ch) : {}); setCopied(false); }
  function reset() { setChannelKey(""); setStep(0); setAnswers({}); setRequester(""); setCopied(false); }
  const set = (key: string, val: string | string[]) => setAnswers((a) => ({ ...a, [key]: val }));
  const toggle = (key: string, opt: string) => setAnswers((a) => { const cur = Array.isArray(a[key]) ? (a[key] as string[]) : []; return { ...a, [key]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] }; });

  function stepValid(): boolean {
    if (!channel || isReview) return true;
    return channel.steps[step].fields.every((f) => {
      if (!f.required || !isFieldShown(f, answers)) return true;
      const v = answers[f.key];
      return Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
    });
  }

  const text = useMemo(() => (channel && isReview ? buildRequestText(channel, answers, { requester, date: TODAY() }) : ""), [channel, isReview, answers, requester]);
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* noop */ } }

  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">쿠폰 등록 요청서</h1>
          <p className="b2b-page-subtitle">채널을 고르고 하나씩 선택하면 <strong>일관된 요청서</strong>가 만들어집니다. 완료 후 복사해 Flow 태스크로 등록하세요. 요청서는 MD의 <strong>등록 체크리스트</strong>가 됩니다.</p>
        </div>
        {channel && <div className="b2b-page-actions"><button className="b2b-btn-secondary" onClick={reset}>채널 다시 선택</button></div>}
      </header>

      {/* 채널 선택 */}
      {!channel && (
        <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          {COUPON_CHANNELS.map((c) => (
            <button key={c.key} className="b2b-card" style={{ textAlign: "left", cursor: "pointer", padding: 18 }} onClick={() => pickChannel(c.key)}>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{c.label}</div>
              <div className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>{c.intro}</div>
              <div style={{ marginTop: 10, color: "var(--sm-orange)", fontWeight: 700, fontSize: 13 }}>시작하기 →</div>
            </button>
          ))}
        </div>
      )}

      {channel && (
        <>
          {/* 진행바 */}
          <div className="sm-row" style={{ gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {channel.steps.map((s, i) => (
              <span key={i} className="sm-row" style={{ gap: 5, fontSize: 12, color: i === step ? "var(--sm-orange)" : i < step ? "var(--sm-text-mid)" : "var(--sm-text-light)", fontWeight: i === step ? 700 : 400 }}>
                <span style={{ width: 20, height: 20, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", background: i < step ? "var(--sm-success)" : i === step ? "var(--sm-orange)" : "var(--sm-border)" }}>{i < step ? "✓" : i + 1}</span>
                {s.title}{i < channel.steps.length - 1 && <span className="sm-faint" style={{ margin: "0 2px" }}>·</span>}
              </span>
            ))}
            <span className="sm-row" style={{ gap: 5, fontSize: 12, color: isReview ? "var(--sm-orange)" : "var(--sm-text-light)", fontWeight: isReview ? 700 : 400 }}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", background: isReview ? "var(--sm-orange)" : "var(--sm-border)" }}>✓</span>완료
            </span>
          </div>

          {/* 단계 */}
          {!isReview && (
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">{step + 1}. {channel.steps[step].title}</span>{channel.steps[step].desc && <span className="sm-faint" style={{ fontSize: 12, marginLeft: 8 }}>{channel.steps[step].desc}</span>}</div>
              {channel.steps[step].fields.map((f) => isFieldShown(f, answers) && <FieldView key={f.key} f={f} answers={answers} set={set} toggle={toggle} />)}
              <div className="sm-between" style={{ marginTop: 18, gap: 10 }}>
                <button className="b2b-btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>이전</button>
                <button className="b2b-btn-primary" onClick={() => setStep((s) => s + 1)} disabled={!stepValid()}>{step === totalSteps - 1 ? "요청서 만들기 →" : "다음 →"}</button>
              </div>
              {!stepValid() && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8, color: "var(--sm-danger)" }}>필수 항목(*)을 선택/입력하세요.</p>}
            </section>
          )}

          {/* 완료 · 미리보기 · 복사 */}
          {isReview && (
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">요청서 완성 — 복사해서 붙여넣으세요</span></div>
              <label className="b2b-field" style={{ maxWidth: 260 }}><span className="b2b-field-label">요청자 이름(선택)</span>
                <input className="b2b-input" value={requester} onChange={(e) => setRequester(e.target.value)} placeholder="예: 홍길동" /></label>
              <pre style={{ whiteSpace: "pre-wrap", background: "var(--sm-bg)", border: "1px solid var(--sm-border)", borderRadius: 8, padding: 14, fontSize: 13, lineHeight: 1.6, marginTop: 10, fontFamily: "inherit" }}>{text}</pre>
              <div className="sm-between" style={{ marginTop: 14, gap: 10, flexWrap: "wrap" }}>
                <button className="b2b-btn-secondary" onClick={() => setStep(totalSteps - 1)}>← 수정</button>
                <div className="sm-row" style={{ gap: 8 }}>
                  <button className="b2b-btn-secondary" onClick={reset}>처음부터</button>
                  <button className="b2b-btn-primary" onClick={copy}>{copied ? "복사됨 ✓" : "📋 요청서 복사"}</button>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function FieldView({ f, answers, set, toggle }: { f: CouponField; answers: Answers; set: (k: string, v: string | string[]) => void; toggle: (k: string, o: string) => void }) {
  const v = answers[f.key];
  return (
    <div className="b2b-field" style={{ marginBottom: 14 }}>
      <label className="b2b-field-label">{f.label}{f.required && <span style={{ color: "var(--sm-danger)" }}> *</span>}</label>
      {(f.type === "radio" || f.type === "checkbox") && (
        <div className="sm-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {f.options?.map((o) => {
            const on = f.type === "radio" ? v === o : Array.isArray(v) && v.includes(o);
            return (
              <button key={o} type="button" onClick={() => (f.type === "radio" ? set(f.key, o) : toggle(f.key, o))}
                style={{ padding: "7px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: `1px solid ${on ? "var(--sm-orange)" : "var(--sm-border)"}`, background: on ? "var(--sm-orange-light)" : "#fff", color: on ? "var(--sm-orange)" : "var(--sm-text-mid)", fontWeight: on ? 700 : 400 }}>
                {f.type === "checkbox" && <span style={{ marginRight: 4 }}>{on ? "☑" : "☐"}</span>}{o}
              </button>
            );
          })}
        </div>
      )}
      {f.type === "text" && <input className="b2b-input" value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />}
      {f.type === "number" && <div className="sm-row" style={{ gap: 6, alignItems: "center" }}><input className="b2b-input" type="number" value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} style={{ maxWidth: 200 }} />{f.suffix && <span className="sm-faint" style={{ fontSize: 13 }}>{f.suffix}</span>}</div>}
      {f.type === "textarea" && <textarea className="b2b-input" rows={2} value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />}
      {f.help && <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 5, lineHeight: 1.5, color: f.help.includes("⚠️") ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{f.help}</p>}
    </div>
  );
}
