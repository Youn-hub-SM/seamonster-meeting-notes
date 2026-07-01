"use client";

import { useEffect, useMemo, useState } from "react";
import { COUPON_CHANNELS, buildRequestText, isFieldShown, isFieldRequired, isDateRange, type CouponChannel, type CouponField, type Answers, type AnswerVal, type DateRange } from "@/app/lib/coupon-form";

const nowKst = () => new Date(Date.now() + 9 * 3600_000);
const TODAY = () => nowKst().toISOString().slice(0, 10);

// 달력 기본값: 시작=오늘 09:00, 종료=+7일 23:59 (시각 누락 방지)
function smartRange(): DateRange {
  const start = nowKst().toISOString().slice(0, 10) + "T09:00";
  const end = new Date(nowKst().getTime() + 7 * 86400_000).toISOString().slice(0, 10) + "T23:59";
  return { start, end };
}

function defaultsFor(ch: CouponChannel): Answers {
  const a: Answers = {};
  for (const s of ch.steps) for (const f of s.fields) {
    if (f.type === "datetime-range") a[f.key] = smartRange();
    else if (f.default !== undefined) a[f.key] = f.default;
  }
  return a;
}

function rangeInvalid(r: DateRange): boolean {
  return !!(r.start && r.end && r.start >= r.end);
}

export default function CouponPage() {
  const [channelKey, setChannelKey] = useState<string>("");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [requester, setRequester] = useState("");
  const [copied, setCopied] = useState(false);
  const [openExtra, setOpenExtra] = useState(false);

  const channel = useMemo(() => COUPON_CHANNELS.find((c) => c.key === channelKey) || null, [channelKey]);
  const totalSteps = channel ? channel.steps.length : 0;
  const isReview = !!channel && step >= totalSteps;

  useEffect(() => { setOpenExtra(false); }, [step, channelKey]);

  function pickChannel(k: string) { setChannelKey(k); setStep(0); const ch = COUPON_CHANNELS.find((c) => c.key === k); setAnswers(ch ? defaultsFor(ch) : {}); setCopied(false); }
  function reset() { setChannelKey(""); setStep(0); setAnswers({}); setRequester(""); setCopied(false); }
  const set = (key: string, val: AnswerVal) => setAnswers((a) => ({ ...a, [key]: val }));
  const toggle = (key: string, opt: string) => setAnswers((a) => { const cur = Array.isArray(a[key]) ? (a[key] as string[]) : []; return { ...a, [key]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] }; });
  const setRange = (key: string, part: "start" | "end", val: string) => setAnswers((a) => { const cur = isDateRange(a[key]) ? (a[key] as DateRange) : { start: "", end: "" }; return { ...a, [key]: { ...cur, [part]: val } }; });

  function fieldValid(f: CouponField): boolean {
    if (!isFieldShown(f, answers)) return true;
    const v = answers[f.key];
    if (f.type === "datetime-range") {
      const r = isDateRange(v) ? v : null;
      if (r && rangeInvalid(r)) return false;               // 기간 역전은 필수 아니어도 차단
      if (!isFieldRequired(f, answers)) return true;
      return !!(r && r.start && r.end);
    }
    if (!isFieldRequired(f, answers)) return true;
    if (Array.isArray(v)) return v.length > 0;
    return !!(v && String(v).trim());
  }
  function stepValid(): boolean {
    if (!channel || isReview) return true;
    return channel.steps[step].fields.every(fieldValid);
  }

  const text = useMemo(() => (channel && isReview ? buildRequestText(channel, answers, { requester, date: TODAY() }) : ""), [channel, isReview, answers, requester]);
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* noop */ } }

  const cur = channel && !isReview ? channel.steps[step] : null;
  const visibleFields = cur ? cur.fields.filter((f) => isFieldShown(f, answers)) : [];
  const collapsed = !!cur?.collapsible && !openExtra;

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
          {cur && (
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">{step + 1}. {cur.title}</span>{cur.desc && <span className="sm-faint" style={{ fontSize: 12, marginLeft: 8 }}>{cur.desc}</span>}</div>

              {cur.note && <p className="sm-faint" style={{ fontSize: 12.5, margin: "0 0 12px", padding: "8px 10px", background: "var(--sm-bg)", borderRadius: 8, lineHeight: 1.5 }}>{cur.note}</p>}

              {collapsed ? (
                <button type="button" className="b2b-btn-secondary" onClick={() => setOpenExtra(true)}>＋ 세부 설정 직접 조정</button>
              ) : visibleFields.length === 0 ? (
                <p className="sm-faint" style={{ fontSize: 13, padding: "6px 0" }}>이 단계에서 입력할 항목이 없습니다. <strong>다음</strong>을 누르세요.</p>
              ) : (
                visibleFields.map((f) => <FieldView key={f.key} f={f} answers={answers} required={isFieldRequired(f, answers)} set={set} toggle={toggle} setRange={setRange} />)
              )}

              <div className="sm-between" style={{ marginTop: 18, gap: 10 }}>
                <button className="b2b-btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>이전</button>
                <button className="b2b-btn-primary" onClick={() => setStep((s) => s + 1)} disabled={!stepValid()}>{step === totalSteps - 1 ? "요청서 만들기 →" : "다음 →"}</button>
              </div>
              {!stepValid() && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8, color: "var(--sm-danger)" }}>필수 항목(*)을 입력하고, 기간은 종료가 시작보다 늦어야 합니다.</p>}
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

const chipStyle = (on: boolean) => ({ padding: "7px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: `1px solid ${on ? "var(--sm-orange)" : "var(--sm-border)"}`, background: on ? "var(--sm-orange-light)" : "#fff", color: on ? "var(--sm-orange)" : "var(--sm-text-mid)", fontWeight: on ? 700 : 400 } as const);

function FieldView({ f, answers, required, set, toggle, setRange }: { f: CouponField; answers: Answers; required: boolean; set: (k: string, v: AnswerVal) => void; toggle: (k: string, o: string) => void; setRange: (k: string, part: "start" | "end", v: string) => void }) {
  const v = answers[f.key];
  const range = isDateRange(v) ? v : { start: "", end: "" };
  return (
    <div className="b2b-field" style={{ marginBottom: 14 }}>
      <label className="b2b-field-label">{f.label}{required && <span style={{ color: "var(--sm-danger)" }}> *</span>}</label>
      {(f.type === "radio" || f.type === "checkbox") && (
        <div className="sm-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {f.options?.map((o) => {
            const on = f.type === "radio" ? v === o : Array.isArray(v) && v.includes(o);
            return (
              <button key={o} type="button" onClick={() => (f.type === "radio" ? set(f.key, o) : toggle(f.key, o))} style={chipStyle(on)}>
                {f.type === "checkbox" && <span style={{ marginRight: 4 }}>{on ? "☑" : "☐"}</span>}{o}
              </button>
            );
          })}
        </div>
      )}
      {f.type === "text" && <input className="b2b-input" value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />}
      {f.type === "number" && <div className="sm-row" style={{ gap: 6, alignItems: "center" }}><input className="b2b-input" type="number" value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} style={{ maxWidth: 200 }} />{f.suffix && <span className="sm-faint" style={{ fontSize: 13 }}>{f.suffix}</span>}</div>}
      {f.type === "textarea" && <textarea className="b2b-input" rows={2} value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />}
      {f.type === "int-days" && (
        <div className="sm-row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {f.presets?.map((p) => <button key={p} type="button" onClick={() => set(f.key, String(p))} style={chipStyle(String(v ?? "") === String(p))}>{p}일</button>)}
          <input className="b2b-input" type="number" value={(v as string) || ""} onChange={(e) => set(f.key, e.target.value)} placeholder="직접" style={{ maxWidth: 90 }} />
          <span className="sm-faint" style={{ fontSize: 13 }}>일</span>
        </div>
      )}
      {f.type === "datetime-range" && (
        <div>
          <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input className="b2b-input" type="datetime-local" value={range.start} onChange={(e) => setRange(f.key, "start", e.target.value)} style={{ maxWidth: 220 }} />
            <span className="sm-faint">~</span>
            <input className="b2b-input" type="datetime-local" value={range.end} onChange={(e) => setRange(f.key, "end", e.target.value)} style={{ maxWidth: 220 }} />
          </div>
          {rangeInvalid(range) && <p style={{ color: "var(--sm-danger)", fontSize: 12, marginTop: 5 }}>종료가 시작보다 빨라요. 다시 확인하세요.</p>}
        </div>
      )}
      {f.help && <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 5, lineHeight: 1.5, color: f.help.includes("⚠️") ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{f.help}</p>}
    </div>
  );
}
