"use client";

import { useMemo, useState } from "react";
import { signedQty, type InvTxnType } from "@/app/lib/inventory";
import { matchKo } from "@/app/lib/hangul";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export type PickProduct = { id: string; name: string; sku: string | null; spec: string | null; unit: string; cost_price: number; qty: number };
type Line = { key: string; product_id: string; name: string; sub: string; unit: string; qty: string; price: string };

// BoxHero 구매창 스타일 — 여러 제품을 한 화면에 담아 입고/출고를 한 번에 기록. 제품 검색은 초성 지원.
export default function PurchaseForm({ products, defaultType = "입고", onClose, onSaved }: {
  products: PickProduct[];
  defaultType?: InvTxnType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<InvTxnType>(defaultType);
  const [date, setDate] = useState(TODAY());
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    return products.filter((p) => matchKo(`${p.name} ${p.sku || ""} ${p.spec || ""}`, q)).slice(0, 8);
  }, [products, search]);

  function addLine(p: PickProduct) {
    const sub = [p.spec, p.sku, `재고 ${p.qty.toLocaleString()}${p.unit}`].filter(Boolean).join(" · ");
    setLines((ls) => [...ls, { key: `${p.id}-${ls.length}-${Date.now()}`, product_id: p.id, name: p.name, sub, unit: p.unit, qty: "1", price: p.cost_price ? String(p.cost_price) : "" }]);
    setSearch("");
  }
  const setLine = (key: string, k: "qty" | "price", v: string) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)));
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  const amountOf = (l: Line) => (Number(l.qty) || 0) * (Number(l.price) || 0);
  const totals = useMemo(() => ({
    items: lines.length,
    qty: lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    amount: lines.reduce((s, l) => s + amountOf(l), 0),
  }), [lines]);

  async function save() {
    const valid = lines.filter((l) => (Number(l.qty) || 0) > 0);
    if (valid.length === 0) { setError("제품과 수량을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const rows = valid.map((l) => ({
        type, qty: signedQty(type, Number(l.qty) || 0), product_id: l.product_id, product_name: l.name,
        unit_amount: Number(l.price) > 0 ? Math.round(Number(l.price)) : null, txn_date: date, partner: partner.trim() || null, memo: memo.trim() || null,
      }));
      const res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, width: "94vw" }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">제품 선택 — {type === "입고" ? "구매(입고)" : "판매(출고)"}</span>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <div className="sm-tabs">
              <button className={`sm-tab ${type === "입고" ? "is-active" : ""}`} onClick={() => setType("입고")}>구매(입고)</button>
              <button className={`sm-tab ${type === "출고" ? "is-active" : ""}`} onClick={() => setType("출고")}>판매(출고)</button>
            </div>
            <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>거래일
              <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} /></label>
            <input className="b2b-input" placeholder={type === "입고" ? "매입처(선택)" : "판매처(선택)"} value={partner} onChange={(e) => setPartner(e.target.value)} style={{ width: 160 }} />
            <input className="b2b-input" placeholder="메모(선택)" value={memo} onChange={(e) => setMemo(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          </div>

          <div className="b2b-table-wrap">
            <table className="b2b-table inv-buy-table">
              <thead><tr><th>제품</th><th className="num" style={{ width: 90 }}>수량</th><th className="num" style={{ width: 130 }}>단가</th><th className="num" style={{ width: 120 }}>금액</th><th style={{ width: 36 }}></th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td><strong>{l.name}</strong>{l.sub && <div className="sm-faint" style={{ fontSize: 11 }}>{l.sub}</div>}</td>
                    <td className="num"><input className="b2b-input" type="number" min={1} value={l.qty} onChange={(e) => setLine(l.key, "qty", e.target.value)} style={{ width: 70, textAlign: "right", padding: "5px 8px" }} /></td>
                    <td className="num"><input className="b2b-input" type="number" min={0} value={l.price} onChange={(e) => setLine(l.key, "price", e.target.value)} style={{ width: 110, textAlign: "right", padding: "5px 8px" }} /></td>
                    <td className="num b2b-money" style={{ fontWeight: 700 }}>₩{amountOf(l).toLocaleString()}</td>
                    <td><button className="b2b-link-btn" onClick={() => removeLine(l.key)} style={{ color: "var(--sm-text-light)" }} aria-label="삭제">✕</button></td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={5} className="sm-faint" style={{ padding: "14px 4px" }}>아래에서 제품을 검색해 추가하세요.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* 제품 추가 — 초성 검색 */}
          <div style={{ position: "relative", marginTop: 8 }}>
            <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="+ 제품 검색 (이름·SKU·초성 ‘ㄴㅇ’)" autoComplete="off" />
            {matches.length > 0 && (
              <div className="inv-buy-suggest">
                {matches.map((p) => (
                  <button key={p.id} className="inv-buy-suggest-item" onClick={() => addLine(p)}>
                    <span><strong>{p.name}</strong> <span className="sm-faint" style={{ fontSize: 11 }}>{[p.spec, p.sku].filter(Boolean).join(" · ")}</span></span>
                    <span className="sm-faint" style={{ fontSize: 11 }}>재고 {p.qty.toLocaleString()}{p.unit}</span>
                  </button>
                ))}
              </div>
            )}
            {search.trim() && matches.length === 0 && <div className="inv-buy-suggest"><div className="sm-faint" style={{ padding: "8px 12px", fontSize: 13 }}>일치하는 제품 없음</div></div>}
          </div>

          {error && <div className="b2b-error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span className="sm-faint" style={{ fontSize: 13 }}>{totals.items}개 품목 · 총 {totals.qty.toLocaleString()}개</span>
          <div className="b2b-modal-foot-right" style={{ alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 16, fontWeight: 800 }}>총액 ₩{totals.amount.toLocaleString()}</span>
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>취소</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving || totals.items === 0}>{saving ? "저장 중…" : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
