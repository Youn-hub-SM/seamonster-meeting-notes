"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow, InvChannel } from "@/app/lib/inventory";
import type { AdjustRow } from "@/app/api/inventory/adjust/import/route";
import TxnModal from "../TxnModal";
import TxnTable from "../TxnTable";
import { ChannelPicker } from "../ChannelTabs";

type Preview = { summary: { valid: number; changed: number; errors: number }; rows: AdjustRow[]; errors: { line: number; msg: string }[] };

export default function AdjustPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [channel, setChannel] = useState<InvChannel>("소매");
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(async () => {
    const j = await (await fetch(`/api/inventory?channel=${encodeURIComponent(channel)}`, { cache: "no-store" })).json();
    if (j.ok) setRows(j.rows || []);
  }, [channel]);
  useEffect(() => { load(); }, [load]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);
  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);

  async function handleFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("channel", channel);
      const res = await fetch("/api/inventory/adjust/import", { method: "POST", body: fd });
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
      const res = await fetch("/api/inventory/adjust/import/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, rows: preview.rows.map((r) => ({ product_id: r.product_id, target: r.target, memo: r.memo })) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      setPreview(null); setReload((n) => n + 1); load();
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setApplying(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고 조정</h1><p className="b2b-page-subtitle">실사·파손·분실 등으로 장부 재고를 보정합니다. <strong>도매/소매 채널</strong>을 고르면 현재고·실사·조정이 그 채널 기준으로 적용됩니다. 실사 수량(목표) 또는 증감(±)으로 입력, <strong>엑셀 대량 실사</strong>도 가능합니다.</p></div>
        <div className="b2b-page-actions">
          <ChannelPicker value={channel} onChange={setChannel} style={{ marginRight: 4 }} />
          <a className="b2b-btn-secondary" href="/api/inventory/adjust/template" title="SKU·실사수량·메모 양식">엑셀 양식</a>
          <label className="b2b-btn-secondary" style={{ cursor: importing ? "default" : "pointer" }}>
            {importing ? "분석 중…" : "엑셀 업로드"}
            <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </label>
          <button className="b2b-btn-primary" onClick={() => setOpen(true)}>+ 조정 기록</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">조정 내역</span></div>
        <TxnTable type="조정" reloadKey={reload} onChanged={load} />
      </section>

      {open && <TxnModal products={products} qtyOf={qtyOf} defaultType="조정" defaultChannel={channel} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReload((n) => n + 1); load(); }} />}

      {preview && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">엑셀 실사 · {channel} — 미리보기</span>
              <button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>실제 변경 <strong style={{ color: "var(--sm-orange)" }}>{preview.summary.changed}</strong>건</span>
                <span className="sm-faint">일치 {preview.summary.valid}건 중</span>
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.rows.length === 0 && <div className="b2b-empty" style={{ padding: 20 }}>매칭된 품목이 없습니다. 양식을 확인하세요.</div>}
              {preview.rows.length > 0 && (
                <div className="b2b-table-wrap" style={{ maxHeight: 340, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>품목</th><th>SKU</th><th className="num">현재고</th><th className="num">실사</th><th className="num">조정</th><th>메모</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 300).map((r, i) => (
                        <tr key={i} style={r.delta === 0 ? { color: "var(--sm-text-light)" } : undefined}>
                          <td>{r.name}{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}</td>
                          <td className="sm-faint">{r.sku || "-"}</td>
                          <td className="num b2b-money">{r.current.toLocaleString()}</td>
                          <td className="num b2b-money" style={{ fontWeight: 700 }}>{r.target.toLocaleString()}</td>
                          <td className="num b2b-money" style={{ fontWeight: 700, color: r.delta > 0 ? "var(--sm-success)" : r.delta < 0 ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{r.delta > 0 ? "+" : ""}{r.delta.toLocaleString()}</td>
                          <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.memo || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행 제외</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 130, overflow: "auto" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.summary.changed === 0}>{applying ? "반영 중…" : `${preview.summary.changed}건 조정`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
