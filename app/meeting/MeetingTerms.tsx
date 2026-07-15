"use client";

import { useEffect, useState, type CSSProperties } from "react";

type Term = { term: string; note?: string };

const inp = (w: number): CSSProperties => ({
  width: w, maxWidth: "100%", padding: "8px 10px",
  border: "1px solid var(--sm-border)", borderRadius: 8, fontSize: 13, fontFamily: "inherit",
});

// 회의정리봇 공유 용어집 — 모든 구성원이 편집. 중복 자동 방지. 회의 요약 시 AI 프롬프트에 반영됨.
export default function MeetingTerms() {
  const [terms, setTerms] = useState<Term[]>([]);
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/meeting/terms", { cache: "no-store" })).json();
        if (j.ok) setTerms(j.terms || []);
      } catch { /* 조용히 무시 */ }
    })();
  }, []);

  async function add() {
    const t = term.trim();
    if (!t || busy) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/meeting/terms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term: t, note }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg(j.error || "추가 실패"); if (Array.isArray(j.terms)) setTerms(j.terms); }
      else { setTerms(j.terms || []); setTerm(""); setNote(""); }
    } catch { setMsg("추가 중 오류가 발생했어요."); }
    setBusy(false);
  }

  async function remove(t: string) {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const j = await (await fetch("/api/meeting/terms?term=" + encodeURIComponent(t), { method: "DELETE" })).json();
      if (j.ok) setTerms(j.terms || []);
    } catch { /* 무시 */ }
    setBusy(false);
  }

  return (
    <section style={{ border: "1px solid var(--sm-orange-border, var(--sm-border))", borderRadius: 12, padding: "14px 16px", marginBottom: 22, background: "var(--sm-bg-warm)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--sm-dark)" }}>
          자주 쓰는 용어
          <span style={{ fontWeight: 400, fontSize: 12, color: "var(--sm-text-light)", marginLeft: 6 }}>· 팀 공유 · {terms.length}개</span>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ background: "none", border: "none", color: "var(--sm-text-mid)", cursor: "pointer", fontSize: 12 }}>
          {open ? "접기" : "펼치기"}
        </button>
      </div>

      {open && (
        <>
          <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "6px 0 12px", lineHeight: 1.6 }}>
            회의 정리 시 AI가 이 용어들을 <strong>정확히 인식·표기</strong>합니다. 모두가 함께 관리해요 (중복은 자동 방지).
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: terms.length ? 12 : 0 }}>
            <input value={term} onChange={(e) => { setTerm(e.target.value); setMsg(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
              placeholder="용어 (예: 골라담기)" style={inp(180)} maxLength={100} />
            <input value={note} onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
              placeholder="뜻·설명 (선택)" style={inp(240)} maxLength={300} />
            <button type="button" className="b2b-btn-primary" onClick={add} disabled={busy || !term.trim()}>
              추가
            </button>
            {msg && <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>{msg}</span>}
          </div>

          {terms.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {terms.map((x) => (
                <span key={x.term} title={x.note || ""}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 999, padding: "4px 6px 4px 12px", fontSize: 12.5 }}>
                  <strong style={{ color: "var(--sm-dark)" }}>{x.term}</strong>
                  {x.note && <span style={{ color: "var(--sm-text-light)" }}>· {x.note}</span>}
                  <button type="button" onClick={() => remove(x.term)} title="삭제" disabled={busy}
                    style={{ border: "none", background: "var(--sm-bg)", color: "var(--sm-text-mid)", borderRadius: "50%", width: 18, height: 18, lineHeight: "16px", cursor: "pointer", fontSize: 12, padding: 0 }}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
