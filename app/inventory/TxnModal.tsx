"use client";

import { useMemo, useState } from "react";
import { INV_TXN_TYPES, type InvTxnType } from "@/app/lib/inventory";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

type Product = { id: string; name: string; sku: string | null; unit: string };

export default function TxnModal({
  products, qtyOf, defaultType = "입고", defaultProductId = "", lockProduct = false, onClose, onSaved,
}: {
  products: Product[];
  qtyOf: (id: string) => number;
  defaultType?: InvTxnType;
  defaultProductId?: string;
  lockProduct?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<InvTxnType>(defaultType);
  const [productId, setProductId] = useState(defaultProductId);
  const [qty, setQty] = useState("");
  const [adjMode, setAdjMode] = useState<"target" | "delta">("target");
  const [unitAmount, setUnitAmount] = useState("");
  const [date, setDate] = useState(TODAY());
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const product = useMemo(() => products.find((p) => p.id === productId), [products, productId]);
  const current = productId ? qtyOf(productId) : 0;
  const isAdjust = type === "조정";

  // 미리보기: 이 거래 후 재고
  const after = useMemo(() => {
    const n = Number(qty) || 0;
    if (type === "입고") return current + Math.abs(n);
    if (type === "출고") return current - Math.abs(n);
    return adjMode === "target" ? n : current + n; // 조정
  }, [type, qty, current, adjMode]);

  async function save() {
    if (!productId) { setError("품목을 선택하세요."); return; }
    let sendQty = Number(qty) || 0;
    if (type === "조정" && adjMode === "target") sendQty = (Number(qty) || 0) - current; // 목표−현재 = 델타
    if (sendQty === 0) { setError("수량을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/inventory/txn", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, type, qty: sendQty, unit_amount: isAdjust ? null : unitAmount, txn_date: date, partner: isAdjust ? "" : partner, memo }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "기록 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "기록 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">입고 · 출고 · 조정</span>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="sm-tabs" style={{ marginBottom: 12 }}>
            {INV_TXN_TYPES.map((t) => (
              <button key={t} className={`sm-tab ${type === t ? "is-active" : ""}`} onClick={() => setType(t)}>{t}</button>
            ))}
          </div>

          <label className="b2b-field"><span className="b2b-field-label">품목</span>
            <select className="b2b-input" value={productId} disabled={lockProduct} onChange={(e) => setProductId(e.target.value)}>
              <option value="">선택…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ""}</option>)}
            </select>
          </label>
          {product && <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>현재고 <strong>{current.toLocaleString()}</strong>{product.unit} → 거래 후 <strong style={{ color: after < 0 ? "var(--sm-danger)" : "var(--sm-black)" }}>{after.toLocaleString()}</strong>{product.unit}</p>}

          {isAdjust && (
            <div className="sm-tabs" style={{ marginBottom: 8 }}>
              <button className={`sm-tab ${adjMode === "target" ? "is-active" : ""}`} onClick={() => setAdjMode("target")}>실사 수량(목표)</button>
              <button className={`sm-tab ${adjMode === "delta" ? "is-active" : ""}`} onClick={() => setAdjMode("delta")}>증감(±)</button>
            </div>
          )}

          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">{isAdjust ? (adjMode === "target" ? "실사 수량" : "증감(±)") : "수량"}</span>
              <input className="b2b-input" type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={isAdjust && adjMode === "delta" ? "예: -3" : "0"} /></label>
            <label className="b2b-field"><span className="b2b-field-label">거래일</span>
              <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </div>

          {!isAdjust && (
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? "매입 단가(원)" : "판매 단가(원)"}</span>
                <input className="b2b-input" type="number" min={0} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} placeholder="선택" /></label>
              <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? "매입처" : "판매처"}</span>
                <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="선택" /></label>
            </div>
          )}
          <label className="b2b-field"><span className="b2b-field-label">메모</span>
            <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={isAdjust ? "조정 사유" : "선택"} /></label>

          {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>취소</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "기록"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
