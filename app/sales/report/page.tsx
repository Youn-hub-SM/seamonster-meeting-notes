"use client";

import { useEffect, useState } from "react";

type Report = {
  ok: boolean; error?: string;
  report_type?: "daily" | "weekly"; base_date?: string; is_sunday?: boolean;
  period_start?: string; period_end?: string;
  subject?: string; html?: string; text?: string;
};

export default function SalesReportPage() {
  const [mode, setMode] = useState<"daily" | "weekly">("daily");
  const [base, setBase] = useState("");
  const [maxDate, setMaxDate] = useState("");
  const [rpt, setRpt] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"" | "gen" | "send">("");
  const [recipients, setRecipients] = useState("");
  const [sent, setSent] = useState<string[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/sales/bounds").then((r) => r.json()).then((j) => {
      if (j?.ok && j.max_date) { setMaxDate(j.max_date); setBase(j.max_date); }
    }).catch(() => {});
  }, []);

  async function generate() {
    setBusy("gen"); setErr(""); setRpt(null); setSent(null);
    try {
      const q = base ? `?base=${base}` : "";
      const r = await fetch(`/api/sales/report/${mode}${q}`);
      const j: Report = await r.json();
      if (!j.ok) setErr(j.error || "생성 실패");
      else setRpt(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function send() {
    if (!rpt?.ok) return;
    setBusy("send"); setErr(""); setSent(null);
    try {
      const list = recipients.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await fetch("/api/sales/report/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_type: rpt.report_type, base_date: rpt.base_date,
          subject: rpt.subject, text: rpt.text, html: rpt.html,
          period_start: rpt.period_start, period_end: rpt.period_end,
          recipients: list,
        }),
      });
      const j = await r.json();
      if (!j.ok) setErr(j.error || "발송 실패");
      else setSent(j.sent_to);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 리포트</h1>
          <p className="b2b-page-subtitle">일일·주간 리포트를 생성해 미리보기로 확인한 뒤 메일로 발송합니다. 일요일 기준일은 자동으로 금~일 합산됩니다.</p>
        </div>
      </header>

      <section className="b2b-card">
        <div className="sm-row" style={{ gap: 8, marginBottom: 12 }}>
          <button className={mode === "daily" ? "b2b-btn-primary" : "b2b-btn-secondary"} onClick={() => { setMode("daily"); setRpt(null); setSent(null); }}>일일 리포트</button>
          <button className={mode === "weekly" ? "b2b-btn-primary" : "b2b-btn-secondary"} onClick={() => { setMode("weekly"); setRpt(null); setSent(null); }}>주간 리포트</button>
        </div>
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-faint" style={{ fontSize: 13 }}>기준일</label>
          <input type="date" value={base} max={maxDate || undefined} onChange={(e) => setBase(e.target.value)} className="b2b-input" style={{ width: 170 }} />
          <button className="b2b-btn-primary" onClick={generate} disabled={busy !== ""}>{busy === "gen" ? "생성 중…" : "미리보기 생성"}</button>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>
          {mode === "daily" ? "일일: 기준일(일요일이면 금~일) 실적 + 누적·채널·Top10." : "주간: 기준일이 속한 주(월~일) 합산 + 전주 대비."} 데이터 최신일 {maxDate || "-"}.
        </p>
      </section>

      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>⚠️ {err}</p>}

      {sent && (
        <section className="b2b-card" style={{ marginTop: 12, borderColor: "var(--sm-success)" }}>
          <div className="b2b-card-head"><span className="b2b-card-title" style={{ color: "var(--sm-success)" }}>발송 완료 ✓</span></div>
          <p style={{ fontSize: 14 }}>수신: {sent.join(", ")}</p>
        </section>
      )}

      {rpt?.ok && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">{rpt.subject}</span></div>
          {rpt.html ? (
            <iframe title="리포트 미리보기" srcDoc={rpt.html} style={{ width: "100%", height: 640, border: "1px solid var(--sm-border)", borderRadius: 8, background: "#fff" }} />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.7, background: "var(--sm-surface-2, #f7fafb)", padding: 16, borderRadius: 8, border: "1px solid var(--sm-border)", fontFamily: "inherit" }}>{rpt.text}</pre>
          )}
          <div style={{ marginTop: 14, borderTop: "1px solid var(--sm-border)", paddingTop: 14 }}>
            <label className="sm-faint" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>수신자 (비우면 기본 수신자 SALES_MAIL_TO로 발송, 쉼표로 여러 명)</label>
            <div className="sm-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="예: ceo@seamonster.kr, sales@seamonster.kr" className="b2b-input" style={{ flex: 1, minWidth: 240 }} />
              <button className="b2b-btn-primary" onClick={send} disabled={busy !== ""}>{busy === "send" ? "발송 중…" : "메일 발송"}</button>
            </div>
            <p className="sm-faint" style={{ fontSize: 11, marginTop: 6 }}>발송 시 발송 이력(sales_reports)에 기록됩니다. 미리보기만으로는 저장·발송되지 않습니다.</p>
          </div>
        </section>
      )}
    </div>
  );
}
