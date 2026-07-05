"use client";

import { useState } from "react";
import Link from "next/link";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7); // KST
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export default function VocManufacturerPage() {
  const [month, setMonth] = useState(THIS_MONTH());
  const [recipient, setRecipient] = useState("");
  const [draft, setDraft] = useState("");
  const [counts, setCounts] = useState<{ claims: number; surveys: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    setLoading(true); setError(""); setCopied(false);
    try {
      const res = await fetch("/api/voc/manufacturer/digest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "초안 생성 실패");
      setDraft(j.draft || "");
      setCounts(j.counts || null);
    } catch (e) { setError(e instanceof Error ? e.message : "초안 생성 실패"); }
    setLoading(false);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError("복사 실패 — 텍스트를 직접 선택해 복사하세요."); }
  }
  async function downloadDocx() {
    setError("");
    try {
      const res = await fetch("/api/voc/manufacturer/docx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, recipient, draft }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Word 생성 실패"); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `씨몬스터_고객반응_${month}.docx`; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Word 생성 실패"); }
  }
  const [y, mm] = month.split("-");
  const exportUrl = `/api/voc/manufacturer/export?month=${month}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ""}`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">월간 VOC 리포트</h1>
          <p className="b2b-page-subtitle">한 달간의 고객 클레임·설문을 <strong>‘고객 반응’ 서술형</strong>으로 AI가 초안을 만듭니다. 다듬어서 인쇄·복사해 제조사에 공유하세요.</p>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href={exportUrl} title="제조사 귀책 건수·청구 손해액(정산용)">⬇ 정산 데이터(엑셀)</a>
          <button className="b2b-btn-secondary" onClick={downloadDocx} disabled={!draft}>📄 Word 다운로드</button>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={!draft}>🖨 인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}

      <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
        <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>대상 월
            <input className="b2b-input" type="month" value={month} max={THIS_MONTH()} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} /></label>
          <input className="b2b-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="수신처(제조사명) — 선택" style={{ width: 200 }} />
          <button className="b2b-btn-primary" onClick={generate} disabled={loading}>{loading ? "AI 작성 중…" : draft ? "🤖 다시 생성" : "🤖 AI 초안 생성"}</button>
          {counts && <span className="sm-faint" style={{ fontSize: 12 }}>클레임 {counts.claims}건 · 설문 {counts.surveys}건 반영</span>}
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>※ 클레임(VOC)·설문(Tally)을 긍정/부정·제품별로 정리합니다(리뷰 섹션 제외). 생성 후 아래에서 직접 고칠 수 있어요. 데이터에 없는 내용은 만들지 않습니다.</p>
      </section>

      {/* 편집 (화면 전용) */}
      {draft && (
        <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
          <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="b2b-card-title">초안 편집</span>
            <button className="b2b-btn-secondary" onClick={copy} style={{ padding: "4px 12px", fontSize: 13 }}>{copied ? "✓ 복사됨" : "📋 텍스트 복사"}</button>
          </div>
          <textarea className="b2b-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={22}
            style={{ width: "100%", fontSize: 13.5, lineHeight: 1.7, fontFamily: "inherit" }} />
        </section>
      )}

      {/* 출력 미리보기 (인쇄 대상) */}
      {draft ? (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "32px 34px", maxWidth: 860, boxShadow: "var(--sm-shadow-card)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
            <div><div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div><h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{y}년 {Number(mm)}월 고객 반응</h2></div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>작성일 {TODAY()}{recipient && <div>수신 · {recipient}</div>}</div>
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.75 }}>{draft.replace(/^\s*\d{4}년\s*\d{1,2}월\s*고객\s*반응\s*\n?/, "")}</div>
        </section>
      ) : (
        !loading && <div className="b2b-empty no-print"><div className="b2b-empty-icon">🗒️</div>대상 월을 고르고 ‘AI 초안 생성’을 누르세요.</div>
      )}

      <p className="sm-faint no-print" style={{ fontSize: 12, marginTop: 12 }}>
        기간 단위 개선요청서는 <Link href="/voc/reports" className="change-link">개선요청서</Link>, 전체 통계는 <Link href="/voc/stats" className="change-link">통계·보고서</Link>에서.
      </p>
    </div>
  );
}
