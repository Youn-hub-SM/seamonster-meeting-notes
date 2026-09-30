"use client";

// 파도소리 품목 마스터(관리자) — SKU · 품목 · 원산지 · 비고 · 제품원가 · 판매가 · 재고관리 사용안함.
//  바꾼 값은 히스토리 '변경'에 남는다. 입출고 기록이 있는 품목은 지울 수 없다(재고관리 사용안함으로 숨긴다).

import { useCallback, useEffect, useMemo, useState } from "react";
import { matchKoQuery } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import { ORIGINS, type FactoryProduct } from "@/app/lib/factory";

const won = (n: number | null) => (n == null ? "-" : `${Number(n).toLocaleString("ko-KR")}원`);

export default function FactoryProductsPage() {
  const [products, setProducts] = useState<FactoryProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kw, setKw] = useState("");
  const [edit, setEdit] = useState<FactoryProduct | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/factory/products", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setProducts(j.products || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => {
    const q = kw.trim();
    return products.filter((p) => !q || matchKoQuery(`${p.name} ${p.sku} ${p.origin || ""} ${p.note || ""}`, q));
  }, [products, kw]);

  return (
    <div className="fac-products">
      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}

      <div className="fac-toolbar">
        <input className="b2b-input fac-search" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="품목·SKU 검색" />
        <button className="b2b-btn-primary" onClick={() => { setNotice(""); setEdit("new"); }}>품목 등록</button>
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
        <div className="b2b-empty">{products.length === 0 ? "등록된 품목이 없습니다." : "조건에 맞는 품목이 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table is-responsive">
            <thead><tr>
              <th>SKU</th><th>품목</th><th>원산지</th><th className="num">제품원가</th><th className="num">판매가</th><th>재고관리</th><th>비고</th><th></th>
            </tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={p.stock_tracked ? "" : "fac-row-off"}>
                  <td data-label="SKU" className="fac-sku">{p.sku}</td>
                  <td data-label="품목"><strong>{p.name}</strong></td>
                  <td data-label="원산지">{p.origin || "-"}</td>
                  <td data-label="제품원가" className="num">{won(p.cost)}</td>
                  <td data-label="판매가" className="num">{won(p.price)}</td>
                  <td data-label="재고관리">
                    {p.stock_tracked ? "사용" : <span className="b2b-status-pill fac-pill-off">사용안함</span>}
                  </td>
                  <td data-label="비고" className="sm-faint">{p.note || "-"}</td>
                  <td className="actions"><button className="b2b-link-btn" onClick={() => { setNotice(""); setEdit(p); }}>수정</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <ProductModal product={edit === "new" ? null : edit} onClose={() => setEdit(null)}
          onSaved={(msg) => { setEdit(null); setNotice(msg); load(); }} />
      )}
    </div>
  );
}

function ProductModal({ product, onClose, onSaved }: { product: FactoryProduct | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [f, setF] = useState({
    sku: product?.sku || "", name: product?.name || "", origin: product?.origin || "", note: product?.note || "",
    cost: product?.cost == null ? "" : String(product.cost), price: product?.price == null ? "" : String(product.price),
    off: product ? !product.stock_tracked : false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEscClose(onClose, saving);
  const set = (patch: Partial<typeof f>) => { setF((x) => ({ ...x, ...patch })); setError(""); };

  async function save() {
    if (!f.sku.trim()) { setError("SKU 를 입력하세요."); return; }
    if (!f.name.trim()) { setError("품목을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const body = { sku: f.sku, name: f.name, origin: f.origin, note: f.note, cost: f.cost, price: f.price, stock_tracked: !f.off };
      const res = await fetch(product ? `/api/factory/products/${product.id}` : "/api/factory/products", {
        method: product ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      onSaved(product ? (j.unchanged ? "바뀐 내용이 없습니다." : "품목을 수정했습니다.") : "품목을 등록했습니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  async function remove() {
    if (!product || !confirm(`${product.name} 품목을 삭제할까요?`)) return;
    setSaving(true); setError("");
    try {
      const res = await fetch(`/api/factory/products/${product.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      onSaved("품목을 삭제했습니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{product ? "품목 수정" : "품목 등록"}</span>
          <button className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body">
          <label className="b2b-field">
            <span className="b2b-field-label">SKU</span>
            <input className="b2b-input" value={f.sku} onChange={(e) => set({ sku: e.target.value })} autoCapitalize="characters" spellCheck={false} />
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">품목</span>
            <input className="b2b-input" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">원산지</span>
            <input className="b2b-input" value={f.origin} onChange={(e) => set({ origin: e.target.value })} list="fac-origins" />
            <datalist id="fac-origins">{ORIGINS.map((o) => <option key={o} value={o} />)}</datalist>
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">비고</span>
            <input className="b2b-input" value={f.note} onChange={(e) => set({ note: e.target.value })} />
          </label>
          <div className="b2b-field-row">
            <label className="b2b-field">
              <span className="b2b-field-label">제품원가(원)</span>
              <input className="b2b-input" type="number" inputMode="numeric" min={0} value={f.cost} onChange={(e) => set({ cost: e.target.value })} />
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">판매가(원)</span>
              <input className="b2b-input" type="number" inputMode="numeric" min={0} value={f.price} onChange={(e) => set({ price: e.target.value })} />
            </label>
          </div>
          <label className="fac-check">
            <input type="checkbox" className="b2b-checkbox" checked={f.off} onChange={(e) => set({ off: e.target.checked })} />
            재고관리 사용안함
          </label>
          {error && <div className="b2b-error">{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          {product && <button className="b2b-btn-danger" onClick={remove} disabled={saving}>삭제</button>}
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>닫기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
