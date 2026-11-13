"use client";

// 신청자 문자 — 탈리 폼 신청자에게 매일 정한 시각 또는 즉시 문자(솔라피). 서버 규칙은 app/lib/form-sms.ts.
//  설정을 켠 뒤에 들어온 신청만 대상이다. 매일 = 그 시각에 모아서, 즉시 = 예약 신호(5분 간격)마다.
//  전화번호는 화면에 가려서만 나온다.
import { useCallback, useEffect, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { dateTime, qty } from "@/app/lib/format";

type Rule = { on: boolean; mode: "daily" | "instant"; time: string; formId: string; formName: string; from: string; text: string; since: string | null; updatedBy?: string; updatedAt?: string };
type Last = { at: string; by: string; sent: number; failed: number; skipped: number; held?: number; error?: string };
type Pending = { id: string; at: string; phone: string | null };
type Log = { id: number; phone_mask: string | null; status: "sending" | "sent" | "failed" | "skipped" | "unknown"; reason: string | null; sent_by: string | null; created_at: string; sent_at: string | null };
type Data = { rule: Rule; last: Last | null; tickAt: string | null; forms: { id: string; name: string }[]; hasTallyKey: boolean; tallyError: string; applied: boolean; configured: boolean; pending: Pending[]; log: Log[]; autoCap: number; tickMinutes: number };

const STATUS: Record<Log["status"], { label: string; bg: string; fg: string }> = {
  sent: { label: "보냄", bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  failed: { label: "실패", bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
  skipped: { label: "건너뜀", bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
  unknown: { label: "확인 필요", bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  sending: { label: "확인 필요", bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
};
const smsBytes = (t: string) => { let n = 0; for (const ch of t) n += ch.charCodeAt(0) > 127 ? 2 : 1; return n; };
const digits = (s: string) => s.replace(/[^0-9]/g, "");
const post = async (body: unknown) => {
  const res = await fetch("/api/form-sms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  return j;
};

export default function FormSmsPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Rule | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "send">("");
  const [testTo, setTestTo] = useState("");

  const load = useCallback(async (keepDraft = false) => {
    try {
      const j = await (await fetch("/api/form-sms", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setData(j);
      if (!keepDraft) setDraft(j.rule);
      setLoadError("");
    } catch (e) { setLoadError(e instanceof Error ? e.message : "신청자 문자 설정을 불러오지 못했습니다."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data || !draft) {
    return (
      <div className="b2b-container">
        <div className="b2b-page-head"><h1 className="b2b-page-title">신청자 문자</h1></div>
        {loadError ? <div className="b2b-error">{loadError}</div> : <div className="b2b-empty">불러오는 중...</div>}
      </div>
    );
  }

  const set = <K extends keyof Rule>(k: K, v: Rule[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = (["on", "mode", "time", "formId", "from", "text"] as const).some((k) => draft[k] !== data.rule[k]);
  const whenOf = (r: Rule) => (r.mode === "instant" ? `${data.tickMinutes}분 안에` : `매일 ${r.time}에`);
  const bytes = smsBytes(draft.text);
  const knownForm = data.forms.some((f) => f.id === draft.formId);
  // 예약 신호는 5분마다 온다 — 20분 넘게 안 왔으면(또는 한 번도) 자동 발송이 제때 돌지 않는 것
  const tickStale = data.rule.on && (!data.tickAt || Date.now() - Date.parse(data.tickAt) > 20 * 60_000);

  const save = async () => {
    setError("");
    const turningOn = draft.on && (!data.rule.on || data.rule.formId !== draft.formId);
    if (turningOn && !(await confirm({ title: "신청자 문자 켜기", body: `지금부터 들어오는 신청자에게 ${whenOf(draft)} 문자를 보냅니다. 이미 들어와 있는 신청에는 보내지 않습니다.`, action: "켜기", danger: false }))) return;
    setBusy("save");
    try {
      const formName = data.forms.find((f) => f.id === draft.formId)?.name || draft.formName || "";
      await post({ action: "save", rule: { ...draft, formName } });
      toast.success("저장했습니다.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const test = async () => {
    setError("");
    if (!(await confirm({ title: "시험 발송", body: `${testTo} 번호로 지금 화면의 문구를 한 통 보냅니다. 문자 요금이 듭니다.`, action: "보내기", danger: false }))) return;
    setBusy("test");
    try { await post({ action: "test", to: testTo, from: draft.from, text: draft.text }); toast.success("시험 문자를 보냈습니다."); }
    catch (e) { setError(e instanceof Error ? e.message : "시험 문자를 보내지 못했습니다."); }
    finally { setBusy(""); }
  };
  const sendNow = async () => {
    setError("");
    if (!(await confirm({ title: "지금 보내기", body: `대기 중인 신청자 ${qty(data.pending.length)}명에게 지금 문자를 보냅니다. 되돌릴 수 없습니다.`, action: "지금 보내기", danger: true }))) return;
    setBusy("send");
    try {
      const j = await post({ action: "send" });
      toast.success(`${qty(j.sent)}명에게 보냈습니다.`);
    } catch (e) { setError(e instanceof Error ? e.message : "보내지 못했습니다."); }
    finally { setBusy(""); await load(true); }
  };

  return (
    <div className="b2b-container">
      <div className="b2b-page-head"><h1 className="b2b-page-title">신청자 문자</h1></div>
      {!data.applied && <div className="b2b-error">migration 167 이 적용되지 않아 발송할 수 없습니다.</div>}
      {!data.configured && <div className="b2b-error">솔라피 키(SOLAPI_API_KEY·SOLAPI_API_SECRET)가 설정되지 않았습니다.</div>}
      {!data.hasTallyKey && <div className="b2b-error">Tally API 키가 없어 신청을 가져올 수 없습니다. 관리자 › 설정 › 연결의 Tally 에 API 키를 저장하세요.</div>}
      {data.tallyError && <div className="b2b-error">{data.tallyError}</div>}
      {tickStale && <div className="sm-warn">예약 신호가 {data.tickMinutes}분마다 오지 않습니다. 정한 시각에 보내려면 migration 168 을 적용하세요.</div>}
      {data.last?.error && <div className="b2b-error">{dateTime(data.last.at)} {data.last.error}</div>}
      {error && <div className="b2b-error">{error}</div>}

      <section className="b2b-form-section">
        <div className="fs-form">
          <div className="b2b-field">
            <span className="b2b-field-label">자동 발송</span>
            <div className="sm-tabs" role="group" aria-label="자동 발송">
              <button type="button" className={`sm-tab ${draft.on ? "is-active" : ""}`} aria-pressed={draft.on} onClick={() => set("on", true)}>켜짐</button>
              <button type="button" className={`sm-tab ${!draft.on ? "is-active" : ""}`} aria-pressed={!draft.on} onClick={() => set("on", false)}>꺼짐</button>
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">보내는 시각</span>
            <div className="fs-inline">
              <div className="sm-tabs" role="group" aria-label="보내는 시각">
                <button type="button" className={`sm-tab ${draft.mode === "daily" ? "is-active" : ""}`} aria-pressed={draft.mode === "daily"} onClick={() => set("mode", "daily")}>매일</button>
                <button type="button" className={`sm-tab ${draft.mode === "instant" ? "is-active" : ""}`} aria-pressed={draft.mode === "instant"} onClick={() => set("mode", "instant")}>즉시</button>
              </div>
              {draft.mode === "daily" && <input type="time" className="b2b-input fs-time" step={300} value={draft.time} onChange={(e) => set("time", e.target.value)} aria-label="매일 보내는 시각" />}
            </div>
          </div>
          <label className="b2b-field">
            <span className="b2b-field-label">탈리 폼</span>
            <select className="b2b-input" value={draft.formId} onChange={(e) => set("formId", e.target.value)}>
              <option value="">폼을 고르세요</option>
              {!knownForm && draft.formId && <option value={draft.formId}>{draft.formName || draft.formId}</option>}
              {data.forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">발신번호</span>
            <input className="b2b-input" inputMode="numeric" value={draft.from} onChange={(e) => set("from", digits(e.target.value))} placeholder="예: 0212345678" />
          </label>
          <label className="b2b-field fs-wide">
            <span className="b2b-field-label">문구</span>
            <textarea className="b2b-textarea fs-text" value={draft.text} onChange={(e) => set("text", e.target.value)} />
            <span className="fs-count">{bytes <= 90 ? `단문 ${qty(bytes)} / 90바이트` : `장문 ${qty(bytes)} / 2,000바이트`}</span>
          </label>
          <div className="fs-actions fs-wide">
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={!!busy || !dirty}>{busy === "save" ? "저장 중" : "저장"}</button>
            <div className="fs-inline">
              <input className="b2b-input" inputMode="numeric" value={testTo} onChange={(e) => setTestTo(digits(e.target.value))} placeholder="시험 받을 번호" aria-label="시험 받을 번호" />
              <button type="button" className="b2b-btn-secondary" onClick={test} disabled={!!busy || testTo.length < 10 || !draft.text.trim() || draft.from.length < 8}>{busy === "test" ? "보내는 중" : "시험 발송"}</button>
            </div>
          </div>
        </div>
      </section>

      <section className="b2b-form-section fs-section">
        <div className="fs-head">
          <span className="fs-num">{qty(data.pending.length)}명</span>
          <span className="fs-sub">
            {data.rule.on && data.rule.since ? `대기 중 · ${dateTime(data.rule.since)} 이후 신청자 · ${whenOf(data.rule)} 발송` : "자동 발송이 꺼져 있습니다"}
          </span>
          <button type="button" className="b2b-btn-secondary fs-end" onClick={sendNow} disabled={!!busy || !data.rule.on || dirty || data.pending.length === 0}>{busy === "send" ? "보내는 중" : "지금 보내기"}</button>
        </div>
        {data.pending.length > data.autoCap && <div className="sm-warn" style={{ marginBottom: "var(--sm-space-3)" }}>대기가 {qty(data.autoCap)}명을 넘으면 자동 발송을 멈춥니다. 대상이 맞는지 확인한 뒤 [지금 보내기]를 누르세요.</div>}
        {data.pending.length > 0 && (
          <div className="b2b-table-wrap">
            <table className="b2b-table fs-table">
              <thead><tr><th>신청 시각</th><th>전화번호</th></tr></thead>
              <tbody>
                {data.pending.slice(0, 50).map((p) => (
                  <tr key={p.id}><td className="sm-nowrap">{dateTime(p.at)}</td><td className="sm-nowrap">{p.phone || "번호를 찾지 못함"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="b2b-form-section fs-section">
        <div className="fs-head">
          <h2 className="b2b-form-section-title" style={{ margin: 0 }}>발송 기록</h2>
          {data.last && !data.last.error && <span className="fs-sub">마지막 실행 {dateTime(data.last.at)} · {data.last.by} · 보냄 {qty(data.last.sent)} · 실패 {qty(data.last.failed)} · 건너뜀 {qty(data.last.skipped)}</span>}
        </div>
        {data.log.length === 0 ? <div className="b2b-empty">아직 보낸 문자가 없습니다.</div> : (
          <div className="b2b-table-wrap">
            <table className="b2b-table fs-table">
              <thead><tr><th>시각</th><th>전화번호</th><th>결과</th><th>보낸 사람</th><th>사유</th></tr></thead>
              <tbody>
                {data.log.map((l) => {
                  const s = STATUS[l.status] || STATUS.unknown;
                  return (
                    <tr key={l.id}>
                      <td className="sm-nowrap">{dateTime(l.sent_at || l.created_at)}</td>
                      <td className="sm-nowrap">{l.phone_mask || "-"}</td>
                      <td><span className="b2b-status-pill" style={{ background: s.bg, color: s.fg }}>{s.label}</span></td>
                      <td className="sm-nowrap">{l.sent_by || "-"}</td>
                      <td className="fs-reason">{l.reason || (l.status === "sending" ? "보내는 도중 멈췄습니다 — 솔라피 발송 내역에서 확인하세요" : "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
