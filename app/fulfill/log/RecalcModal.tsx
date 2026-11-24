"use client";

// 배송일지 — [운임 다시 계산] 창(2026-11-24). 관리자만 쓴다(서버가 확인).
//  발주처리에서 기록한 기본운임·도착보장 운임은 기록할 때의 단가로 저장된다. 단가를 나중에 넣었으면(적용 시작일이 과거)
//  그 사이 기록을 '그 날짜의 단가'로 다시 계산해 바꾼다 — /api/fulfill/log/recalc. 미리보기 → 확인 → 적용.
//  박스 수·직접수정·추가운임은 건드리지 않는다.
import { useEffect, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { qty, won } from "@/app/lib/format";

type Row = { date: string; cur_normal: number; new_normal: number; cur_guar: number; new_guar: number };
type Preview = { from: string; to: string; checked: number; rows: Row[]; totals: { days: number; cur: number; next: number }; skipped: { date: string; unknown: string[] }[]; expect: string };
const diff = (a: number, b: number) => { const d = b - a; return d === 0 ? "-" : `${d > 0 ? "+" : "−"}${won(Math.abs(d))}원`; };

export default function RecalcModal({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "preview" | "apply">("load");

  useEffect(() => {
    fetch("/api/fulfill/log/recalc", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error);
      setFrom(j.from); setTo(j.to);
      if (!j.admin) setError("관리자만 운임을 다시 계산할 수 있습니다.");
    }).catch((e) => setError(e instanceof Error ? e.message : "단가 설정을 읽지 못했습니다.")).finally(() => setBusy(""));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy && !document.querySelector(".sm-confirm")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const post = async (body: unknown) => {
    const j = await (await fetch("/api/fulfill/log/recalc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (!j.ok) throw new Error(j.error || "운임을 다시 계산하지 못했습니다.");
    return j;
  };
  const run = async () => {
    setError(""); setPreview(null);
    if (!from || !to || from > to) { setError("기간을 확인하세요."); return; }
    setBusy("preview");
    try { setPreview(await post({ from, to })); }
    catch (e) { setError(e instanceof Error ? e.message : "운임을 다시 계산하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const apply = async () => {
    if (!preview || !preview.rows.length) return;
    const t = preview.totals;
    if (!(await confirm({ title: "운임 다시 계산 적용", body: `${preview.from} ~ ${preview.to} 가운데 ${qty(t.days)}일의 기본운임을 바꿉니다.\n${won(t.cur)}원 → ${won(t.next)}원 (${diff(t.cur, t.next)})\n박스 수와 직접 고친 값은 그대로 둡니다.`, action: `${qty(t.days)}일 적용` }))) return;
    setBusy("apply"); setError("");
    try {
      const j = await post({ from: preview.from, to: preview.to, apply: true, expect: preview.expect });
      if (j.conflicts?.length) toast.error(`${qty(j.applied)}일을 바꿨습니다. ${j.conflicts.join(", ")}은 그 사이 다시 기록돼 바꾸지 않았습니다 — 미리보기를 다시 누르세요.`);
      else toast.success(`${qty(j.applied)}일의 운임을 다시 계산했습니다`);
      onApplied();
      if (j.conflicts?.length) { setPreview(null); } else onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "적용하지 못했습니다."); }
    finally { setBusy(""); }
  };

  return (
    <div className="b2b-modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="b2b-modal" role="dialog" aria-modal="true" aria-label="운임 다시 계산" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">운임 다시 계산</span>
          <button type="button" className="b2b-modal-close" aria-label="닫기" onClick={onClose} disabled={!!busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {error && <div className="b2b-error">{error}</div>}
          <div className="b2b-field">
            <span className="b2b-field-label">기간</span>
            <div className="sm-row" style={{ gap: "var(--sm-space-2)", alignItems: "center", flexWrap: "wrap" }}>
              <input type="date" className="b2b-input" style={{ width: "auto" }} value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} aria-label="시작일" />
              <span>~</span>
              <input type="date" className="b2b-input" style={{ width: "auto" }} value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} aria-label="종료일" />
              <button type="button" className="b2b-btn-secondary" onClick={run} disabled={!!busy}>{busy === "preview" ? "계산 중" : "미리보기"}</button>
            </div>
          </div>
          {preview && (<>
            {preview.skipped.length > 0 && <div className="sm-warn">계산하지 못한 날짜 {qty(preview.skipped.length)}일 — 설정에 없는 박스 종류가 있어 무게를 알 수 없습니다: {preview.skipped.map((s) => `${s.date}(${s.unknown.join(", ")})`).join(", ")}</div>}
            {preview.rows.length === 0 ? <div className="b2b-empty">기록 {qty(preview.checked)}일을 확인했습니다. 바꿀 날짜가 없습니다.</div> : (<>
              <div className="sm-success">기록 {qty(preview.checked)}일 가운데 {qty(preview.totals.days)}일이 바뀝니다 · {won(preview.totals.cur)}원 → {won(preview.totals.next)}원 ({diff(preview.totals.cur, preview.totals.next)})</div>
              <div className="b2b-table-wrap" style={{ flexShrink: 0 }}>
                <table className="b2b-table">
                  <thead><tr><th>날짜</th><th className="num">일반 지금</th><th className="num">일반 다시</th><th className="num">도착보장 지금</th><th className="num">도착보장 다시</th><th className="num">차이</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.date}>
                        <td className="sm-nowrap">{r.date}</td>
                        <td className="num">{won(r.cur_normal)}</td><td className="num">{won(r.new_normal)}</td>
                        <td className="num">{won(r.cur_guar)}</td><td className="num">{won(r.new_guar)}</td>
                        <td className="num sm-nowrap">{diff(r.cur_normal + r.cur_guar, r.new_normal + r.new_guar)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>)}
          </>)}
        </div>
        <div className="b2b-modal-foot">
          <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={!!busy}>닫기</button>
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-primary" onClick={apply} disabled={!!busy || !preview?.rows.length}>{busy === "apply" ? "적용 중" : preview?.rows.length ? `${qty(preview.totals.days)}일 적용` : "적용"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
