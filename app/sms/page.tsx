"use client";

// 문자 보내기 — 받는 번호와 내용을 적어 고객에게 문자를 보낸다.
//  실제 발송은 중계 서버(클라우드웨이즈)가 알리고 API 로 한다(알리고는 등록한 서버 IP 에서만 받는다). 여기서는 요청을 줄 세우고 결과를 본다.
//  요청 → 2분 안에 발송 서버가 가져감 → 결과(접수·거절 건수). 08~21시(한국 시간)에만 보낸다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import {
  parseReceivers, smsBytes, msgTypeOf, hasUnsupportedChars,
  SMS_BYTES, LMS_BYTES, LMS_TITLE_BYTES, SMS_MAX_RECEIVERS, SEND_FROM_HOUR, SEND_UNTIL_HOUR, RUNNER_LATE_MS, type SmsSend,
} from "@/app/lib/sms-send";
import { qty, dateTime } from "@/app/lib/format";

const POLL_MS = 10_000; // 대기·보내는 중인 문자가 있을 때만 다시 읽는다

function StatusPill({ s }: { s: SmsSend }) {
  const tone = s.status === "완료" ? { background: "var(--sm-success-bg)", color: "var(--sm-success)" }
    : s.status === "실패" || s.status === "확인 필요" ? { background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }
    : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" };
  const label = s.status === "실행중" ? "보내는 중" : s.status === "완료" && s.test ? "시험 완료" : s.status;
  return <span className="b2b-status-pill" style={tone}>{label}</span>;
}

export default function SmsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [receivers, setReceivers] = useState("");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [sends, setSends] = useState<SmsSend[]>([]);
  const [runnerLast, setRunnerLast] = useState<string | null>(null);
  const [remain, setRemain] = useState<{ sms?: number; lms?: number } | null>(null);
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const j = await (await fetch("/api/sms/sends", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setSends(j.sends || []); setRunnerLast(j.runnerLast || null); setRemain(j.remain || null); setOpen(j.open !== false); setPending(j.pending || ""); setLoadError(""); setNow(Date.now());
    } catch (e) { setLoadError(e instanceof Error ? e.message : "발송 기록을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const active = sends.some((s) => s.status === "대기" || s.status === "실행중");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const parsed = useMemo(() => parseReceivers(receivers), [receivers]);
  const bytes = useMemo(() => smsBytes(message.trim()), [message]);
  const type = msgTypeOf(message.trim());
  const limit = type === "SMS" ? SMS_BYTES : LMS_BYTES;
  const runnerLate = !pending && open && (!runnerLast || now - Date.parse(runnerLast) > RUNNER_LATE_MS);

  const send = async () => {
    const errs: string[] = [];
    if (!parsed.valid.length && !parsed.invalid.length) errs.push("받는 번호를 입력하세요.");
    if (parsed.invalid.length) errs.push(`휴대폰 번호가 아닌 것이 있습니다: ${parsed.invalid.slice(0, 5).join(", ")}${parsed.invalid.length > 5 ? ` 외 ${parsed.invalid.length - 5}개` : ""}`);
    if (parsed.valid.length > SMS_MAX_RECEIVERS) errs.push(`한 번에 ${qty(SMS_MAX_RECEIVERS)}명까지 보낼 수 있습니다. 나눠서 보내세요.`);
    if (!message.trim()) errs.push("내용을 입력하세요.");
    if (bytes > LMS_BYTES) errs.push(`내용은 ${qty(LMS_BYTES)}바이트 이하`);
    if (type === "LMS" && smsBytes(title.trim()) > LMS_TITLE_BYTES) errs.push(`제목은 ${LMS_TITLE_BYTES}바이트 이하`);
    setErrors(errs);
    if (errs.length) return;
    if (!(await confirm({ title: "문자 보내기", body: `${qty(parsed.valid.length)}명에게 ${type} 문자를 보냅니다. 보낸 문자는 취소할 수 없습니다.`, action: "문자 보내기" }))) return;
    setSending(true);
    try {
      const j = await (await fetch("/api/sms/sends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receivers, message, title: type === "LMS" ? title : "" }) })).json();
      if (!j.ok) throw new Error(j.error);
      setSends((list) => [j.send, ...list]);
      setReceivers(""); setMessage(""); setTitle("");
      toast.success("문자를 보냈습니다. 2분 안에 발송됩니다");
    } catch (e) { setErrors([e instanceof Error ? e.message : "문자를 보내지 못했습니다."]); }
    finally { setSending(false); }
  };

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">문자 보내기</h1>
      </div>

      {pending && <div className="sm-warn">{pending}</div>}
      {loadError && <div className="b2b-error">{loadError}</div>}
      {!open && <div className="sm-warn">문자는 {SEND_FROM_HOUR}시부터 {SEND_UNTIL_HOUR}시 전까지만 보낼 수 있습니다.</div>}
      {runnerLate && <div className="sm-warn">발송 서버의 신호가 없습니다. 지금 보내면 30분 뒤 실패로 닫힙니다. 관리자에게 알리세요.</div>}

      <section className="b2b-form-section" style={{ marginTop: "var(--sm-space-4)" }}>
        <div className="sms-form">
          {errors.length > 0 && <div className="b2b-error">{errors.length === 1 ? errors[0] : <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}</div>}
          <div className="b2b-field">
            <label className="b2b-field-label" htmlFor="sms-receivers">
              받는 번호
              {(parsed.valid.length > 0 || parsed.invalid.length > 0) && (
                <span className={`sms-count ${parsed.invalid.length || parsed.valid.length > SMS_MAX_RECEIVERS ? "is-over" : ""}`}>
                  {qty(parsed.valid.length)}명{parsed.duplicates ? ` · 중복 ${qty(parsed.duplicates)}개 제외` : ""}{parsed.invalid.length ? ` · 잘못된 번호 ${qty(parsed.invalid.length)}개` : ""}
                </span>
              )}
            </label>
            <textarea id="sms-receivers" className="b2b-input sms-receivers" value={receivers} onChange={(e) => setReceivers(e.target.value)}
              placeholder={"예: 010-1234-5678\n010-2345-6789"} aria-invalid={parsed.invalid.length > 0 || undefined} spellCheck={false} />
          </div>
          {type === "LMS" && (
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="sms-title">제목 <span className="opt">선택</span></label>
              <input id="sms-title" className="b2b-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 씨몬스터 배송 안내" maxLength={40} />
            </div>
          )}
          <div className="b2b-field">
            <label className="b2b-field-label" htmlFor="sms-message">
              내용
              <span className={`sms-count ${bytes > LMS_BYTES ? "is-over" : ""}`}>{type} {qty(bytes)}/{qty(limit)}바이트</span>
            </label>
            <textarea id="sms-message" className="b2b-input sms-message" value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="예: [씨몬스터] 주문하신 상품이 오늘 출고되었습니다." />
          </div>
          {hasUnsupportedChars(message) && <div className="sm-warn">이모지는 문자에서 물음표로 바뀝니다.</div>}
          <div className="sms-actions">
            <button type="button" className="b2b-btn-primary" onClick={send} disabled={sending || !!pending || !open}>{sending ? "보내는 중" : "문자 보내기"}</button>
            {remain && <span className="sms-remain">알리고 잔여 SMS {qty(remain.sms ?? 0)}건 · LMS {qty(remain.lms ?? 0)}건</span>}
          </div>
        </div>
      </section>

      <div className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
        <div className="b2b-card-head"><span className="b2b-card-title">발송 기록</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div>
          : sends.length === 0 ? <div className="b2b-empty">보낸 문자가 없습니다.</div>
          : (
            <div className="b2b-table-wrap">
              <table className="b2b-table sms-table">
                <thead><tr><th>보낸 시각</th><th>보낸 사람</th><th>종류</th><th className="num">받는 사람</th><th>내용</th><th>결과</th></tr></thead>
                <tbody>
                  {sends.map((s) => (
                    <tr key={s.id}>
                      <td className="sm-nowrap">{dateTime(s.created_at)}</td>
                      <td>{s.requested_by || "-"}</td>
                      <td className="sm-nowrap">{s.msg_type}</td>
                      <td className="num">{qty(s.receiver_count)}명<span className="sms-sub">{s.receiver_preview}{s.receiver_count > 3 ? " 외" : ""}</span></td>
                      <td className="sms-msg-cell">{s.title && <strong>{s.title}{"\n"}</strong>}{s.message}</td>
                      <td>
                        <StatusPill s={s} />
                        {s.status === "완료" && <span className="sms-sub">접수 {qty(s.success_cnt ?? 0)}건{s.error_cnt ? ` · 거절 ${qty(s.error_cnt)}건` : ""}{s.test ? " · 실제로 나가지 않음" : ""}</span>}
                        {s.error && <span className="sms-sub">{s.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
