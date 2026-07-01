"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BundlePreview } from "@/app/api/inventory/bundles/import/route";
import { Combobox, ComboOption } from "../../b2b/orders/Combobox";

type BundleRow = { parent_id: string; parent_sku: string | null; parent_name: string; components: { component_id: string; sku: string | null; name: string; spec: string | null; qty: number }[] };
type PreviewResp = { summary: { bundles: number; valid: number; willCreate: number; errors: number }; previews: BundlePreview[] };
type ProdLite = { sku: string | null; name: string; spec: string | null };

export default function BundlesPage() {
  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [products, setProducts] = useState<ProdLite[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/inventory/bundles", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setBundles(j.bundles || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  // 구성품 검색용 상품 목록
  useEffect(() => { (async () => { try { const j = await (await fetch("/api/b2b/products", { cache: "no-store" })).json(); if (Array.isArray(j.products)) setProducts(j.products.map((p: ProdLite) => ({ sku: p.sku, name: p.name, spec: p.spec }))); } catch { /* noop */ } })(); }, []);

  async function handleFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch("/api/inventory/bundles/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview(j as PreviewResp);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const rows = preview.previews.filter((p) => p.ok).map((p) => ({ parentSku: p.parentSku, name: p.name, components: p.components.map((c) => ({ sku: c.sku, qty: c.qty })) }));
      const res = await fetch("/api/inventory/bundles/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundles: rows }) });
      const j = await res.json();
      if (!res.ok || !j.ok) { if (j.errors?.length) throw new Error(j.errors.join(" / ")); throw new Error(j.error || "반영 실패"); }
      setPreview(null); load();
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setApplying(false);
  }
  async function removeBundle(b: BundleRow) {
    if (!confirm(`"${b.parent_name}" 묶음 구성을 삭제할까요? (상품 자체는 유지)`)) return;
    await fetch(`/api/inventory/bundles?parent=${b.parent_id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">묶음 상품</h1>
          <p className="b2b-page-subtitle">세트 SKU를 <strong>구성품 × 수량</strong>으로 묶습니다(원가·가격 불필요). 판매/구매 엑셀에 세트 SKU가 나오면 자동으로 구성품으로 분해돼요. <strong>엑셀로 한 번에 등록</strong>하세요.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={() => setAddOpen(true)}>+ 직접 추가</button>
          <a className="b2b-btn-secondary" href="/api/inventory/bundles/template" title="묶음SKU·묶음명·구성품SKU·수량">엑셀 양식</a>
          <label className="b2b-btn-secondary" style={{ cursor: importing ? "default" : "pointer" }}>
            {importing ? "분석 중…" : "엑셀 업로드"}
            <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </label>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("product_bundles") || error.includes("relation")) ? " — supabase/migrations/037_product_bundles.sql 를 먼저 적용하세요." : ""}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : bundles.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📦</div>등록된 묶음이 없습니다. 위 <strong>엑셀 양식</strong>을 받아 채운 뒤 <strong>엑셀 업로드</strong>하세요.</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>묶음(세트)</th><th>SKU</th><th>구성품</th><th></th></tr></thead>
            <tbody>
              {bundles.map((b) => (
                <tr key={b.parent_id}>
                  <td><strong>{b.parent_name}</strong> <span className="b2b-feed-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)", fontSize: 10, fontWeight: 700 }}>세트</span></td>
                  <td className="sm-faint">{b.parent_sku || "-"}</td>
                  <td>
                    <div className="sm-col" style={{ gap: 2 }}>
                      {b.components.map((c) => (
                        <span key={c.component_id} style={{ fontSize: 13 }}>{c.name}{c.spec ? <span className="sm-faint" style={{ fontSize: 11 }}> {c.spec}</span> : null} <strong>× {c.qty}</strong> {c.sku ? <span className="sm-faint" style={{ fontSize: 11 }}>({c.sku})</span> : null}</span>
                      ))}
                    </div>
                  </td>
                  <td><button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} onClick={() => removeBundle(b)}>삭제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>※ 개별 편집은 <strong>상품 마스터</strong>의 각 상품 ‘묶음’ 버튼에서도 가능합니다. 구성품은 이미 등록된 상품이어야 하며, 묶음SKU가 없으면 업로드 시 최소 정보로 자동 생성됩니다.</p>

      {/* 미리보기 → 반영 */}
      {preview && (
        <div className="b2b-modal-backdrop" onClick={() => !applying && setPreview(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <div className="b2b-modal-head"><span className="b2b-modal-title">묶음 업로드 — 미리보기</span><button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button></div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>반영 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.valid}</strong>개</span>
                {preview.summary.willCreate > 0 && <span className="sm-faint">신규 세트 상품 {preview.summary.willCreate}개 생성</span>}
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}개(제외)</span>}
              </div>
              <div className="b2b-table-wrap" style={{ maxHeight: 380, overflow: "auto" }}>
                <table className="b2b-table">
                  <thead><tr><th>묶음SKU</th><th>구성</th><th>상태</th></tr></thead>
                  <tbody>
                    {preview.previews.map((p, i) => (
                      <tr key={i} style={p.ok ? undefined : { background: "var(--sm-danger-bg)" }}>
                        <td><strong>{p.parentSku}</strong><div className="sm-faint" style={{ fontSize: 11 }}>{p.name}{!p.parentExists ? " · 신규생성" : ""}</div></td>
                        <td><div className="sm-col" style={{ gap: 1 }}>{p.components.map((c, ci) => (
                          <span key={ci} style={{ fontSize: 12, color: c.ok ? undefined : "var(--sm-danger)" }}>{c.name || c.sku} × {c.qty} {c.ok ? "" : `— ${c.err}`}</span>
                        ))}</div></td>
                        <td style={{ whiteSpace: "nowrap" }}>{p.ok ? <span style={{ color: "var(--sm-success)" }}>OK</span> : <span style={{ color: "var(--sm-danger)", fontSize: 12 }}>{p.err || "구성품 오류"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right">
              <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
              <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.summary.valid === 0}>{applying ? "반영 중…" : `${preview.summary.valid}개 반영`}</button>
            </div></div>
          </div>
        </div>
      )}

      {addOpen && <AddBundleModal products={products} onClose={() => setAddOpen(false)} onSaved={load} />}
    </div>
  );
}

// 직접 추가 — 묶음 SKU(코드)·이름 입력 후 구성품(상품 검색)×수량 매칭. apply 라우트 재사용(부모 없으면 자동생성).
function AddBundleModal({ products, onClose, onSaved }: { products: ProdLite[]; onClose: () => void; onSaved: () => void }) {
  const [parentSku, setParentSku] = useState("");
  const [name, setName] = useState("");
  const [rows, setRows] = useState<{ sku: string; label: string; qty: number | string }[]>([{ sku: "", label: "", qty: 1 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const options: ComboOption[] = useMemo(
    () => products.map((p) => ({ id: p.sku || "", label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "" })).filter((o) => o.id),
    [products]
  );

  async function save() {
    if (!parentSku.trim()) { setError("묶음 SKU(코드)를 입력하세요."); return; }
    const comps = rows.filter((r) => r.sku && Number(r.qty) > 0).map((r) => ({ sku: r.sku, qty: Number(r.qty) }));
    if (!comps.length) { setError("구성품을 1개 이상 추가하세요."); return; }
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/inventory/bundles/import/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundles: [{ parentSku: parentSku.trim(), name: name.trim(), components: comps }] }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { if (j.errors?.length) throw new Error(j.errors.join(" / ")); throw new Error(j.error || "저장 실패"); }
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">묶음 직접 추가</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          <div className="b2b-field-row">
            <div className="b2b-field"><label className="b2b-field-label">묶음 SKU(코드)</label>
              <input className="b2b-input" value={parentSku} onChange={(e) => setParentSku(e.target.value)} placeholder="예: SET-DG-100" /></div>
            <div className="b2b-field"><label className="b2b-field-label">묶음명(선택)</label>
              <input className="b2b-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 대구 실속세트" /></div>
          </div>
          <p className="sm-faint" style={{ fontSize: 11.5, margin: "-2px 0 8px" }}>이 SKU가 상품에 없으면 최소 정보로 자동 생성됩니다(원가·가격 불필요).</p>
          <div className="b2b-field-label" style={{ fontWeight: 700 }}>구성품</div>
          {rows.map((r, i) => (
            <div key={i} className="promo-item-row">
              <div className="promo-item-combo">
                <Combobox value={r.label} options={options} onSelect={(o) => setRows((rs) => rs.map((x, xi) => (xi === i ? { ...x, sku: o.id, label: o.label } : x)))} placeholder="상품 검색(이름·SKU)" ariaLabel="구성품" />
              </div>
              <input type="number" min={1} className="b2b-input promo-item-qty" value={r.qty} onChange={(e) => setRows((rs) => rs.map((x, xi) => (xi === i ? { ...x, qty: e.target.value } : x)))} placeholder="수량" />
              <button type="button" className="promo-item-del" onClick={() => setRows((rs) => rs.filter((_, xi) => xi !== i))} title="삭제">✕</button>
            </div>
          ))}
          <button type="button" className="promo-item-add" style={{ marginTop: 8 }} onClick={() => setRows((rs) => [...rs, { sku: "", label: "", qty: 1 }])}>+ 구성품 추가</button>
          {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right">
          <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>취소</button>
          <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
        </div></div>
      </div>
    </div>
  );
}
