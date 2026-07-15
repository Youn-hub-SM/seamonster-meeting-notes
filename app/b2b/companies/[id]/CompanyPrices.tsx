"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox } from "../../orders/Combobox";

type Price = { product_id: string; unit_price: number; memo: string | null; name: string; sku: string | null; spec: string | null; default_price: number };
type Prod = { id: string; name: string; sku: string | null; spec: string | null; sale_price: number; active: boolean; is_bundle?: boolean };

// 거래처 전용 단가 — 상품×단가 오버라이드. 발주 화면에서 이 거래처 선택 시 자동 적용, 없으면 기본 판매가.
export default function CompanyPrices({ companyId }: { companyId: string }) {
  const [prices, setPrices] = useState<Price[]>([]);
  const [products, setProducts] = useState<Prod[]>([]);
  const [pick, setPick] = useState<Prod | null>(null);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const j = await (await fetch(`/api/b2b/companies/${companyId}/prices`, { cache: "no-store" })).json();
      if (j.ok) setPrices(j.prices || []);
    } catch { /* noop */ }
    setLoading(false);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/b2b/products", { cache: "no-store" })).json();
        if (j.ok) setProducts((j.products as Prod[]).filter((p) => p.active)); // 번들 포함(발주는 번들 많음)
      } catch { /* noop */ }
    })();
  }, []);

  const options = useMemo(() => {
    const taken = new Set(prices.map((p) => p.product_id));
    return products.filter((p) => !taken.has(p.id)).map((p) => ({ id: p.id, label: p.spec ? `${p.name} · ${p.spec}` : p.name, sub: p.sku ?? "" }));
  }, [products, prices]);

  async function save(product_id: string, unit_price: number) {
    setBusy(true); setErr("");
    try {
      const j = await (await fetch(`/api/b2b/companies/${companyId}/prices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id, unit_price }) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      await load();
      setPick(null); setPrice("");
    } catch (e) { setErr(e instanceof Error ? e.message : "저장 오류"); }
    setBusy(false);
  }
  async function remove(product_id: string) {
    if (!confirm("이 상품의 거래처 단가를 삭제할까요? (발주 시 기본 판매가로 돌아갑니다)")) return;
    setBusy(true); setErr("");
    try {
      const j = await (await fetch(`/api/b2b/companies/${companyId}/prices?product_id=${product_id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "삭제 오류"); }
    setBusy(false);
  }

  return (
    <section className="b2b-card" style={{ marginBottom: 16 }}>
      <div className="b2b-card-head">
        <h2 className="b2b-card-title">거래처 전용 단가</h2>
        <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>발주 시 자동 적용 · 없으면 기본 판매가 · 재고는 안 나뉨</span>
      </div>
      {err && <div className="b2b-error" style={{ marginBottom: 10 }}>{err}</div>}

      {/* 추가 */}
      <div className="sm-row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <label className="sm-col" style={{ gap: 3, flex: 1, minWidth: 200 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>상품</span>
          <Combobox value={pick ? (pick.spec ? `${pick.name} · ${pick.spec}` : pick.name) : ""} options={options}
            onSelect={(o) => { const p = products.find((x) => x.id === o.id) ?? null; setPick(p); if (p && !price) setPrice(String(p.sale_price || "")); }}
            placeholder="상품명·SKU 검색" ariaLabel="상품 선택" emptyText="일치하는 상품이 없습니다" />
        </label>
        <label className="sm-col" style={{ gap: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>단가(원)</span>
          <input type="number" className="b2b-input" style={{ width: 120, textAlign: "right" }} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
        </label>
        <button className="b2b-btn-primary" disabled={busy || !pick || !price} onClick={() => pick && save(pick.id, Math.round(Number(price) || 0))}>추가</button>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : prices.length === 0 ? (
        <div className="b2b-empty">등록된 거래처 단가가 없습니다. 위에서 상품을 골라 단가를 정하세요.</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>품목</th><th className="num">거래처 단가</th><th className="num">기본판매가</th><th></th></tr></thead>
            <tbody>
              {prices.map((p) => <PriceRow key={p.product_id} p={p} busy={busy} onSave={(v) => save(p.product_id, v)} onRemove={() => remove(p.product_id)} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PriceRow({ p, busy, onSave, onRemove }: { p: Price; busy: boolean; onSave: (v: number) => void; onRemove: () => void }) {
  const [v, setV] = useState(String(p.unit_price));
  useEffect(() => { setV(String(p.unit_price)); }, [p.unit_price]);
  const changed = Math.round(Number(v) || 0) !== p.unit_price;
  return (
    <tr>
      <td><strong>{p.name}</strong>{p.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{p.sku}</span> : null}{p.spec ? <span className="sm-faint" style={{ marginLeft: 4, fontSize: 12 }}>· {p.spec}</span> : null}</td>
      <td className="num"><input type="number" className="b2b-input" style={{ width: 110, textAlign: "right" }} value={v} onChange={(e) => setV(e.target.value)} /></td>
      <td className="num sm-faint">{p.default_price.toLocaleString()}</td>
      <td>
        <div className="sm-row" style={{ gap: 6, justifyContent: "flex-end" }}>
          {changed && <button className="b2b-btn-primary" style={{ padding: "4px 10px" }} disabled={busy} onClick={() => onSave(Math.round(Number(v) || 0))}>저장</button>}
          <button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} disabled={busy} onClick={onRemove}>삭제</button>
        </div>
      </td>
    </tr>
  );
}
