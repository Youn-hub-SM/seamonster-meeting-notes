"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow } from "@/app/lib/inventory";
import TxnModal from "../TxnModal";
import TxnTable from "../TxnTable";

type ImportRow = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null };
type Preview = { summary: { valid: number; errors: number }; rows: ImportRow[]; errors: { line: number; msg: string }[] };

export default function TradePage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(async () => {
    const j = await (await fetch("/api/inventory", { cache: "no-store" })).json();
    if (j.ok) setRows(j.rows || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);
  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);

  async function handleFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch("/api/inventory/txns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview(j as Preview);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: preview.rows }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "적용 실패");
      setPreview(null); setReload((n) => n + 1); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "적용 실패"); }
    setApplying(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">구매 및 판매</h1><p className="b2b-page-subtitle">입고(매입)·출고(판매·소진)를 기록합니다. <strong>엑셀로 한 번에</strong> 올리거나, 한 건씩 입력하세요.</p></div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href="/api/inventory/txns/template" title="입출고 엑셀 양식 내려받기">엑셀 양식</a>
          <label className="b2b-btn-secondary" style={{ cursor: importing ? "default" : "pointer" }}>
            {importing ? "분석 중…" : "엑셀 업로드"}
            <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </label>
          <button className="b2b-btn-primary" onClick={() => setOpen(true)}>+ 입고/판매 기록</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">입고·출고 내역</span></div>
        <TxnTable types={["입고", "출고"]} reloadKey={reload} onChanged={load} />
      </section>

      {open && <TxnModal products={products} qtyOf={qtyOf} defaultType="입고" onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReload((n) => n + 1); load(); }} />}

      {preview && (
        <div className="b2b-modal-backdrop" onClick={() => !applying && setPreview(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 업로드 — 미리보기</h2>
              <button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>반영 가능 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.valid}</strong>건</span>
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.summary.valid === 0 && <div className="b2b-empty" style={{ padding: 20 }}>반영할 행이 없습니다.</div>}

              {preview.rows.length > 0 && (
                <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>날짜</th><th>유형</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: "nowrap" }}>{r.txn_date?.slice(5)}</td>
                          <td><span className="b2b-feed-pill" style={{ background: r.type === "입고" ? "var(--sm-success-bg)" : "var(--sm-info-bg)", color: r.type === "입고" ? "var(--sm-success)" : "var(--sm-info)", fontWeight: 700 }}>{r.type}</span></td>
                          <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product_name}</td>
                          <td className="num b2b-money" style={{ color: r.qty >= 0 ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 700 }}>{r.qty > 0 ? "+" : ""}{r.qty.toLocaleString()}</td>
                          <td className="num b2b-money">{r.unit_amount ? r.unit_amount.toLocaleString() : "-"}</td>
                          <td>{r.partner || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 200 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>…외 {preview.rows.length - 200}건(전체 반영됩니다)</p>}
                </div>
              )}

              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행은 제외</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 140, overflow: "auto" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.summary.valid === 0}>
                  {applying ? "반영 중…" : `${preview.summary.valid}건 반영`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
