"use client";

// 묶음(세트) 구성 편집 — 부모 상품에 '구성품 × 수량'을 지정. 저장 시 product_bundles 교체.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox, ComboOption } from "../b2b/orders/Combobox";

type ProductLite = { id: string; sku: string | null; name: string; spec?: string | null };
type Row = { component_id: string; label: string; qty: number | string };

export default function BundleEditor({ parent, products, onClose, onSaved }: {
  parent: { id: string; name: string; sku: string | null };
  products: ProductLite[];
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await (await fetch(`/api/b2b/products/bundle?parent=${encodeURIComponent(parent.id)}`, { cache: "no-store" })).json();
      if (j.ok) setRows((j.components || []).map((c: { component_id: string; name: string; spec: string | null; qty: number }) => ({ component_id: c.component_id, label: c.spec ? `${c.name} | ${c.spec}` : c.name, qty: c.qty })));
    } catch { /* noop */ }
    setLoading(false);
  }, [parent.id]);
  useEffect(() => { load(); }, [load]);

  // 자기 자신 제외한 상품 옵션
  const options: ComboOption[] = useMemo(
    () => products.filter((p) => p.id !== parent.id).map((p) => ({ id: p.id, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "" })),
    [products, parent.id]
  );

  async function save() {
    const valid = rows.filter((r) => r.component_id && (Number(r.qty) || 0) > 0);
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/b2b/products/bundle", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_id: parent.id, components: valid.map((r) => ({ component_id: r.component_id, qty: Number(r.qty) })) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      onSaved?.(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">묶음 구성 — {parent.name}{parent.sku ? ` (${parent.sku})` : ""}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>이 상품(세트) 1개가 어떤 구성품 몇 개로 이뤄지는지 지정하세요. 판매/구매 엑셀에서 이 세트 SKU가 나오면 <strong>구성품으로 분해</strong>되어 재고에 반영됩니다. (구성품이 있으면 세트는 자체 재고를 잡지 않고 <strong>가용 세트 수</strong>로 표시)</p>
          {loading ? <div className="b2b-loading">불러오는 중...</div> : (
            <>
              {rows.map((r, i) => (
                <div key={i} className="promo-item-row">
                  <div className="promo-item-combo">
                    <Combobox value={r.label} options={options} onSelect={(o) => setRows((rs) => rs.map((x, xi) => (xi === i ? { ...x, component_id: o.id, label: o.label } : x)))} placeholder="구성품 검색" ariaLabel="구성품" />
                  </div>
                  <input type="number" min={1} className="b2b-input promo-item-qty" value={r.qty} onChange={(e) => setRows((rs) => rs.map((x, xi) => (xi === i ? { ...x, qty: e.target.value } : x)))} placeholder="수량" />
                  <button type="button" className="promo-item-del" onClick={() => setRows((rs) => rs.filter((_, xi) => xi !== i))} title="삭제">✕</button>
                </div>
              ))}
              {rows.length === 0 && <div className="sm-faint" style={{ fontSize: 12, padding: "6px 0" }}>구성품이 없습니다. 아래에서 추가하세요.</div>}
              <button type="button" className="promo-item-add" style={{ marginTop: 8 }} onClick={() => setRows((rs) => [...rs, { component_id: "", label: "", qty: 1 }])}>+ 구성품 추가</button>
              {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
            </>
          )}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>취소</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>{saving ? "저장 중…" : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
