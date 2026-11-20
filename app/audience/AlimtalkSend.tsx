"use client";

// 오디언스 추출 — [알림톡 보내기](구매 고객·정기배송 고객 공용, 2026-11-20). 내부 직원 누구나 보낸다.
//  찾은 조건 그대로 서버가 '보내는 순간에' 다시 찾아 솔라피 알림톡을 보낸다(app/lib/audience-send.ts) — 정보성 알림톡·대체 발송 없음·즉시만·야간 차단.
//  창을 열 때 요청 번호를 하나 만든다 — 같은 창에서 다시 눌러도(응답을 못 받았을 때 포함) 서버가 한 번만 보낸다.
//  아래 SendHistory = 알림톡 발송 기록 카드(모든 직원이 본다).
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";
import { qty, dateTime } from "@/app/lib/format";

type VarRule = { kind: "name" } | { kind: "text"; value: string };
type Template = { templateId: string; name: string; content: string; variables: string[] };
export type SendRow = {
  id: number; kind: string; mode: string; cond_summary: string | null; template_name: string | null; variables: Record<string, VarRule> | null;
  target_count: number; attempted: number | null; accepted: number | null; failed: number | null; status: "sending" | "sent" | "partial" | "failed" | "unknown"; reason: string | null;
  result: { success: number; failed: number; pending: number; checked_at: string } | null; sent_by: string | null; created_at: string;
};
type Outcome = { status: SendRow["status"]; target: number; attempted: number; accepted: number; failed: number; reason: string; notMobile?: number };

const NAME_HINT = /이름|성함|성명|고객|회원|name/i; // 이런 이름의 변수는 처음부터 [고객 이름]
const newId = () => crypto.randomUUID();
const post = async (body: unknown) => {
  const res = await fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || "알림톡을 보내지 못했습니다.");
  return j;
};
const outcomeText = (o: Outcome): string => {
  const head = o.status === "sent" ? `${qty(o.accepted)}명에게 알림톡을 접수했습니다`
    : o.status === "unknown" ? "솔라피 응답을 받지 못했습니다 — 발송 기록을 확인하세요"
    : o.status === "failed" ? "한 통도 접수되지 않았습니다"
    : `${qty(o.target)}명 중 ${qty(o.accepted)}명만 접수했습니다`;
  return [head, o.reason].filter(Boolean).join(" · ");
};

export default function AlimtalkSend({ payload, count, summary, sends, disabled, onSent }: {
  payload: unknown;            // 방금 찾은 조건(서버로 그대로 보낸다)
  count: number;               // 화면에서 확인한 인원
  summary: string;             // 조건 한 줄
  sends: SendRow[] | null;     // 발송 기록 — 같은 조건·템플릿으로 오늘 이미 보냈는지 알리는 데 쓴다
  disabled?: boolean;
  onSent: () => void;          // 보낸 뒤 기록을 다시 읽는다
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [windowOpen, setWindowOpen] = useState(true);
  const [nightMessage, setNightMessage] = useState("");
  const [max, setMax] = useState(10_000);
  const [tpl, setTpl] = useState<Template | null>(null);
  const [vars, setVars] = useState<Record<string, VarRule>>({});
  const [testTo, setTestTo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "test">("");
  const requestId = useRef("");

  const show = () => {
    requestId.current = newId();
    setOpen(true); setError(""); setTpl(null); setVars({});
    fetch("/api/audience?templates=1", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error);
      setTemplates(j.templates || []); setWindowOpen(!!j.open); setNightMessage(j.nightMessage || ""); if (j.max) setMax(j.max);
    }).catch((e) => setError(e instanceof Error ? e.message : "알림톡 템플릿을 불러오지 못했습니다."));
  };
  const close = () => { if (!busy) setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy && !document.querySelector(".sm-confirm")) setOpen(false); }; // 확인 창이 떠 있으면 Esc 는 그 창만 닫는다
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  const options: ComboOption[] = useMemo(() => (templates || []).map((t) => ({ id: t.templateId, label: t.name || t.templateId })), [templates]);
  const pick = (o: ComboOption) => {
    const t = templates?.find((x) => x.templateId === o.id) || null;
    setTpl(t); setError("");
    setVars(Object.fromEntries((t?.variables || []).map((n) => [n, NAME_HINT.test(n) ? { kind: "name" } : { kind: "text", value: "" }] as [string, VarRule])));
  };
  const setVar = (n: string, r: VarRule) => setVars((v) => ({ ...v, [n]: r }));
  // 빈 칸이 남은 변수 — 있으면 보내지 않는다
  const missing = tpl ? tpl.variables.find((n) => { const r = vars[n]; return !r || (r.kind === "text" && !r.value.trim()); }) : undefined;
  const ready = (): boolean => {
    if (!tpl) { setError("템플릿을 고르세요."); return false; }
    if (missing) { setError(`변수 #{${missing}}에 넣을 값을 적으세요.`); return false; }
    setError(""); return true;
  };

  const sendTest = async () => {
    if (!ready() || !tpl) return;
    if (!testTo.replace(/\D/g, "")) { setError("시험 발송할 휴대폰 번호를 적으세요."); return; }
    setBusy("test");
    try {
      const o = (await post({ action: "test", requestId: newId(), templateId: tpl.templateId, vars, phone: testTo })) as Outcome;
      if (o.status === "sent") toast.success("시험 알림톡을 접수했습니다"); else setError(outcomeText(o));
      onSent();
    } catch (e) { setError(e instanceof Error ? e.message : "시험 발송에 실패했습니다."); }
    finally { setBusy(""); }
  };

  const send = async () => {
    if (!ready() || !tpl) return;
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const again = (sends || []).some((s) => s.kind === "send" && s.template_name === tpl.name && s.cond_summary === summary && new Date(new Date(s.created_at).getTime() + 9 * 3600_000).toISOString().slice(0, 10) === today);
    const body = `${qty(count)}명에게 '${tpl.name}' 알림톡을 지금 보냅니다. 보내는 순간에 조건으로 다시 찾으므로 인원이 조금 다를 수 있습니다. 되돌릴 수 없습니다.${again ? "\n\n오늘 같은 조건·같은 템플릿으로 이미 보낸 기록이 있습니다." : ""}`;
    if (!(await confirm({ title: "알림톡 보내기", body, action: `${qty(count)}명에게 보내기` }))) return;
    setBusy("send");
    try {
      const o = (await post({ action: "send", cond: payload, requestId: requestId.current, templateId: tpl.templateId, vars, expected: count })) as Outcome;
      const text = outcomeText(o) + (o.notMobile ? ` · 휴대폰 번호가 아닌 ${qty(o.notMobile)}명 제외` : "");
      if (o.status === "sent") toast.success(text); else toast.error(text);
      setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : "알림톡을 보내지 못했습니다. 발송 기록을 확인하세요."); }
    finally { setBusy(""); onSent(); }
  };

  const over = count > max;
  return (
    <>
      <button type="button" className="b2b-btn-secondary" onClick={show} disabled={disabled || count === 0}>알림톡 보내기</button>
      {open && (
        <div className="b2b-modal-backdrop" onClick={close}>
          <div className="b2b-modal" role="dialog" aria-modal="true" aria-label="알림톡 보내기" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">알림톡 보내기</span>
              <button type="button" className="b2b-modal-close" aria-label="닫기" onClick={close} disabled={!!busy}>✕</button>
            </div>
            <div className="b2b-modal-body">
              {error && <div className="b2b-error">{error}</div>}
              {!windowOpen && <div className="sm-warn">{nightMessage}</div>}
              {over && <div className="sm-warn">한 번에 {qty(max)}명까지 보냅니다. 조건을 좁히세요.</div>}
              <div className="aud-send-target"><span className="aud-send-count">{qty(count)}명</span><span className="aud-send-cond">{summary}</span></div>
              <div className="b2b-field">
                <span className="b2b-field-label">템플릿</span>
                <Combobox value={tpl?.name || ""} options={options} onSelect={pick} ariaLabel="알림톡 템플릿 검색" placeholder="알림톡 템플릿 검색"
                  emptyText={templates ? "승인된 알림톡 템플릿이 없습니다" : "템플릿을 불러오는 중..."} />
              </div>
              {tpl?.content && <div className="aud-send-preview" aria-label="템플릿 본문">{tpl.content}</div>}
              {tpl?.variables.map((n) => {
                const r = vars[n] || { kind: "text", value: "" };
                return (
                  <div className="b2b-field" key={n}>
                    <span className="b2b-field-label">{`#{${n}}`}</span>
                    <div className="aud-send-var">
                      <div className="sm-tabs" role="group" aria-label={`#{${n}}에 넣을 값`}>
                        <button type="button" className={`sm-tab ${r.kind === "name" ? "is-active" : ""}`} aria-pressed={r.kind === "name"} onClick={() => setVar(n, { kind: "name" })}>고객 이름</button>
                        <button type="button" className={`sm-tab ${r.kind === "text" ? "is-active" : ""}`} aria-pressed={r.kind === "text"} onClick={() => setVar(n, { kind: "text", value: r.kind === "text" ? r.value : "" })}>직접 입력</button>
                      </div>
                      {r.kind === "text" && <input className="b2b-input" value={r.value} maxLength={200} onChange={(e) => setVar(n, { kind: "text", value: e.target.value })} aria-label={`#{${n}} 값`} />}
                    </div>
                  </div>
                );
              })}
              <div className="b2b-field">
                <span className="b2b-field-label">시험 발송</span>
                <div className="aud-send-var">
                  <input className="b2b-input" type="tel" inputMode="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="010-0000-0000" aria-label="시험 발송할 휴대폰 번호" />
                  <button type="button" className="b2b-btn-secondary" onClick={sendTest} disabled={!!busy || !windowOpen}>{busy === "test" ? "보내는 중" : "시험 발송"}</button>
                </div>
              </div>
            </div>
            <div className="b2b-modal-foot">
              <button type="button" className="b2b-btn-secondary" onClick={close} disabled={!!busy}>닫기</button>
              <div className="b2b-modal-foot-right">
                <button type="button" className="b2b-btn-primary" onClick={send} disabled={!!busy || !windowOpen || over}>{busy === "send" ? "보내는 중" : `${qty(count)}명에게 보내기`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── 알림톡 발송 기록 ──
const STATUS: Record<SendRow["status"], { label: string; style: React.CSSProperties }> = {
  sent: { label: "접수", style: { background: "var(--sm-success-bg)", color: "var(--sm-success)" } },
  partial: { label: "일부 접수", style: { background: "var(--sm-bg-subtle)", color: "var(--sm-black)" } },
  failed: { label: "접수 실패", style: { background: "var(--sm-danger-bg)", color: "var(--sm-danger)" } },
  unknown: { label: "확인 필요", style: { background: "var(--sm-danger-bg)", color: "var(--sm-danger)" } },
  sending: { label: "보내는 중", style: { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" } },
};
const STALE_MS = 10 * 60_000; // '보내는 중'이 이보다 오래 남아 있으면 도중에 끊긴 것 — 확인 필요

export function SendHistory({ sends, canSend, onChanged }: { sends: SendRow[]; canSend: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [checking, setChecking] = useState<number | null>(null);
  const check = async (id: number) => {
    setChecking(id);
    try { await post({ action: "send_result", id }); onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "결과를 확인하지 못했습니다."); }
    finally { setChecking(null); }
  };
  return (
    <div className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
      <div className="b2b-card-head"><span className="b2b-card-title">알림톡 발송 기록</span></div>
      {sends.length === 0 ? <div className="b2b-empty">알림톡 발송 기록이 없습니다.</div> : (
        <div className="b2b-table-wrap">
          <table className="b2b-table aud-sends">
            <thead><tr><th>시각</th><th>누가</th><th>상태</th><th>템플릿</th><th className="num">대상</th><th className="num">접수</th><th className="num">접수 실패</th><th>수신 결과</th><th>조건</th><th></th></tr></thead>
            <tbody>
              {sends.map((s) => {
                const stale = s.status === "sending" && Date.now() - new Date(s.created_at).getTime() > STALE_MS;
                const st = STATUS[stale ? "unknown" : s.status] || STATUS.unknown;
                return (
                  <tr key={s.id}>
                    <td className="sm-nowrap">{dateTime(s.created_at)}</td>
                    <td className="sm-nowrap">{s.sent_by || "-"}</td>
                    <td><span className="b2b-status-pill" style={st.style}>{st.label}</span></td>
                    <td className="aud-cond-cell">{s.template_name || "-"}</td>
                    <td className="num">{qty(s.target_count)}명</td>
                    <td className="num">{s.accepted == null ? "-" : `${qty(s.accepted)}명`}</td>
                    <td className="num">{s.failed == null ? "-" : `${qty(s.failed)}명`}</td>
                    <td className="sm-nowrap">{s.result ? `완료 ${qty(s.result.success)} · 실패 ${qty(s.result.failed)}${s.result.pending ? ` · 대기 ${qty(s.result.pending)}` : ""}` : "-"}</td>
                    <td className="aud-cond-cell">{s.kind === "test" ? "시험 발송" : s.cond_summary}{s.reason ? <div className="aud-send-reason">{s.reason}</div> : null}</td>
                    <td className="actions sm-nowrap">{canSend && (s.accepted || 0) > 0 && <button type="button" className="b2b-link-btn" onClick={() => check(s.id)} disabled={checking != null}>{checking === s.id ? "확인 중" : "결과 확인"}</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
