"use client";

// 묶음(세트) 구성 편집 — 부모 상품에 '구성품 × 수량'을 지정. 저장 시 product_bundles 교체.
import { useEscClose } from "@/app/lib/use-esc";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { Combobox, ComboOption } from "../b2b/orders/Combobox";

type ProductLite = { id: string; sku: string | null; name: string; spec?: string | null };
type Row = { component_id: string; label: string; qty: number | string };

export default function BundleEditor({ parent, products, onClose, onSaved }: {
  parent: { id: string; name: string; sku: string | null };
  products: ProductLite[];
  onClose: () => void;
  onSaved?: () => void;
}) {
  useEscClose(onClose);
  const [rows, setRows] = useState<Row[]>([]);
  const [loadedCount, setLoadedCount] = useState(0); // 불러온 구성품 수 — 전부 지우고 저장하면 세트가 풀리므로 확인을 받는다
  const [loading, setLoading] = useState(true);
  // 구성 조회 실패(S4) — 빈 구성으로 열어 그대로 저장하면 세트가 풀린다. 실패면 표시하고 저장을 막는다.
  const [loadErr, setLoadErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [badRow, setBadRow] = useState<number | null>(null); // 검증에 걸린 줄(수량 칸 빨강)
  const confirmModal = useConfirm();

  const load = useCallback(async () => {
    setLoading(true); setLoadErr("");
    try {
      const r = await fetch(`/api/b2b/products/bundle?parent=${encodeURIComponent(parent.id)}`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || "구성을 불러오지 못했습니다");
      const list: Row[] = (j.components || []).map((c: { component_id: string; name: string; spec: string | null; qty: number }) => ({ component_id: c.component_id, label: c.spec ? `${c.name} | ${c.spec}` : c.name, qty: c.qty }));
      setRows(list); setLoadedCount(list.length);
    } catch (e) { setRows([]); setLoadedCount(0); setLoadErr(e instanceof Error ? e.message : "구성을 불러오지 못했습니다"); }
    setLoading(false);
  }, [parent.id]);
  useEffect(() => { load(); }, [load]);

  // 자기 자신 제외한 상품 옵션
  const options: ComboOption[] = useMemo(
    () => products.filter((p) => p.id !== parent.id).map((p) => ({ id: p.id, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "" })),
    [products, parent.id]
  );

  async function save() {
    if (loadErr || loading) { setError("기존 구성을 불러오지 못해 저장할 수 없습니다 — [다시 불러오기]를 누르세요."); return; }
    const picked = rows.filter((r) => r.component_id);
    // 수량은 1 이상 정수만 — 서버가 반올림·1 로 바꿔 저장하므로 화면에서 먼저 막는다(조용히 다른 수량이 되지 않게)
    const badQty = picked.find((r) => { const n = Number(String(r.qty).trim()); return String(r.qty).trim() === "" || !Number.isInteger(n) || n < 1; });
    if (badQty) { setBadRow(rows.indexOf(badQty)); setError(`'${badQty.label}' 수량은 1 이상 정수`); return; }
    // 같은 구성품 두 줄은 서버도 거절한다 — 한 줄로 합치게 먼저 알린다
    const seen = new Set<string>();
    const dup = picked.find((r) => { if (seen.has(r.component_id)) return true; seen.add(r.component_id); return false; });
    if (dup) { setBadRow(rows.indexOf(dup)); setError(`'${dup.label}'이(가) 두 줄 있습니다 — 한 줄로 합치세요`); return; }
    setBadRow(null);
    if (!picked.length && loadedCount > 0 && !(await confirmModal({ title: "묶음 풀기", body: `구성품 ${loadedCount}개를 모두 지우면 묶음이 풀려 일반 품목이 됩니다.`, action: "묶음 풀고 저장" }))) return;
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/b2b/products/bundle", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_id: parent.id, components: picked.map((r) => ({ component_id: r.component_id, qty: Number(r.qty) })) }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) throw new Error(j?.error || "구성을 저장하지 못했습니다. 기존 구성은 그대로이니 다시 저장하세요");
      onSaved?.(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "구성을 저장하지 못했습니다. 기존 구성은 그대로이니 다시 저장하세요"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">묶음 구성 — {parent.name}{parent.sku ? ` (${parent.sku})` : ""}</h2>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>세트 SKU는 구성품으로 분해되어 재고에 반영됩니다.</p>
          {error && <div className="b2b-error" style={{ marginBottom: 8 }}>{error}</div>}
          {loading ? <div className="b2b-loading">불러오는 중...</div> : loadErr ? (
            <div className="b2b-error">
              구성을 불러오지 못했습니다 — {loadErr}. 이대로는 저장할 수 없습니다.{" "}
              <button type="button" className="b2b-link-btn" onClick={() => { setError(""); void load(); }}>다시 불러오기</button>
            </div>
          ) : (
            <>
              {rows.map((r, i) => (
                <div key={i} className="promo-item-row">
                  <div className="promo-item-combo">
                    <Combobox value={r.label} options={options} onSelect={(o) => setRows((rs) => rs.map((x, xi) => (xi === i ? { ...x, component_id: o.id, label: o.label } : x)))} placeholder="품목·SKU 검색" ariaLabel="구성품" invalid={badRow === i && !r.component_id} />
                  </div>
                  <input type="number" min={1} step={1} className="b2b-input promo-item-qty" value={r.qty} onChange={(e) => setRows((rs) => rs.map((x, xi) => (xi === i ? { ...x, qty: e.target.value } : x)))} aria-label="수량" aria-invalid={badRow === i ? "true" : undefined} />
                  <button type="button" className="promo-item-del" onClick={() => setRows((rs) => rs.filter((_, xi) => xi !== i))} title="삭제">✕</button>
                </div>
              ))}
              {rows.length === 0 && <div className="sm-faint" style={{ fontSize: 12, padding: "6px 0" }}>구성품이 없습니다.</div>}
              <button type="button" className="promo-item-add" style={{ marginTop: 8 }} onClick={() => setRows((rs) => [...rs, { component_id: "", label: "", qty: 1 }])}>+ 구성품 추가</button>
            </>
          )}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>그만두기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving || loading || !!loadErr}>{saving ? "저장 중..." : "구성 저장"}</button>
            {!!loadErr && !loading && <span className="b2b-btn-why">구성을 불러오지 못해 저장할 수 없습니다</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
