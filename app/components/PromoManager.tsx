"use client";

// 프로모션 관리 모달 — 재고/생산 공용. 프로모션 기간·상품별 예상판매를 등록하면
//  안전재고 계산(getPromoForwardBySku)에 '남은 행사분'이 자동 반영된다.
import { useEscClose } from "@/app/lib/use-esc";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { Combobox, ComboOption } from "../b2b/orders/Combobox";

type PromoItem = { sku: string; name: string; qty: number | string };
type Promotion = { id: string; name: string; start: string; end: string; items: PromoItem[]; expectedQty: number; note?: string; color?: string };
type ProductLite = { sku: string | null; name: string; spec?: string | null };

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const EMPTY: Partial<Promotion> = { name: "", start: "", end: "", items: [], note: "" };

export default function PromoManager({ products, onClose, onChanged }: { products: ProductLite[]; onClose: () => void; onChanged?: () => void }) {
  useEscClose(onClose);
  const [list, setList] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Partial<Promotion> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErr, setFieldErr] = useState<{ name?: string; start?: string; end?: string }>({}); // 칸별 검증 오류
  const confirmModal = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await (await fetch("/api/production/promotions", { cache: "no-store" })).json();
      if (j.ok) setList(j.promotions || []);
    } catch { /* noop */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const productOptions: ComboOption[] = useMemo(
    () => products.map((p) => ({ id: p.sku || p.name, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "" })),
    [products]
  );
  const total = (draft?.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0);
  const setItems = (fn: (items: PromoItem[]) => PromoItem[]) => setDraft((d) => (d ? { ...d, items: fn(d.items || []) } : d));

  async function save() {
    if (!draft) return;
    const fe: { name?: string; start?: string; end?: string } = {};
    if (!draft.name?.trim()) fe.name = "프로모션 이름을 입력하세요";
    if (!draft.start) fe.start = "시작일을 입력하세요";
    if (!draft.end) fe.end = "종료일을 입력하세요";
    setFieldErr(fe);
    if (fe.name || fe.start || fe.end) return;
    setSaving(true); setError("");
    try {
      const j = await (await fetch("/api/production/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setList(j.promotions || []); setDraft(null); onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  async function remove(id: string) {
    if (!(await confirmModal({ title: "프로모션 삭제", body: "프로모션이 목록에서 지워집니다. 되돌릴 수 없습니다.", action: "프로모션 삭제" }))) return;
    setSaving(true);
    try { const j = await (await fetch(`/api/production/promotions?id=${id}`, { method: "DELETE" })).json(); if (j.ok) { setList(j.promotions || []); setDraft(null); onChanged?.(); } } catch { /* noop */ }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">프로모션 관리</h2>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>행사 기간의 판매를 하루 출고 평균에서 뺍니다.</p>

          {!draft && (
            <>
              {loading ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
                <div className="b2b-empty" style={{ padding: 18 }}>등록된 프로모션이 없습니다.</div>
              ) : (
                <div className="sm-col" style={{ gap: 6, marginBottom: 10 }}>
                  {list.map((p) => (
                    <button key={p.id} className="b2b-card" style={{ textAlign: "left", cursor: "pointer", padding: "10px 12px" }} onClick={() => setDraft(p)}>
                      <div className="sm-between"><strong>{p.name}</strong><span className="sm-faint" style={{ fontSize: 12 }}>예상 {p.expectedQty.toLocaleString()}개</span></div>
                      <div className="sm-faint" style={{ fontSize: 12 }}>{p.start} ~ {p.end} · {(p.items || []).length}개 품목</div>
                    </button>
                  ))}
                </div>
              )}
              <button className="b2b-btn-primary" onClick={() => setDraft({ ...EMPTY, start: TODAY(), end: TODAY() })}>+ 프로모션 추가</button>
            </>
          )}

          {draft && (
            <>
              {(() => {
                const msgs = [fieldErr.name, fieldErr.start, fieldErr.end].filter(Boolean) as string[];
                if (!msgs.length && !error) return null;
                return <div className="b2b-error" style={{ marginBottom: 8 }}>{msgs.length > 1 ? <ul>{msgs.map((m) => <li key={m}>{m}</li>)}</ul> : (msgs[0] || error)}</div>;
              })()}
              <div className="b2b-field"><label className="b2b-field-label">이름<span className="req">*</span></label>
                <input className="b2b-input" value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="예: 6월 라방 특가" aria-invalid={fieldErr.name ? "true" : undefined} />
                {fieldErr.name && <span className="b2b-field-error">{fieldErr.name}</span>}</div>
              <div className="b2b-field-row">
                <div className="b2b-field"><label className="b2b-field-label">시작일<span className="req">*</span></label>
                  <input type="date" className="b2b-input" value={draft.start || ""} onChange={(e) => setDraft({ ...draft, start: e.target.value })} aria-invalid={fieldErr.start ? "true" : undefined} />
                  {fieldErr.start && <span className="b2b-field-error">{fieldErr.start}</span>}</div>
                <div className="b2b-field"><label className="b2b-field-label">종료일<span className="req">*</span></label>
                  <input type="date" className="b2b-input" value={draft.end || ""} onChange={(e) => setDraft({ ...draft, end: e.target.value })} aria-invalid={fieldErr.end ? "true" : undefined} />
                  {fieldErr.end && <span className="b2b-field-error">{fieldErr.end}</span>}</div>
              </div>
              <div className="b2b-field"><label className="b2b-field-label">상품별 예상 판매량</label>
                {(draft.items || []).map((it, i) => (
                  <div key={i} className="promo-item-row">
                    <div className="promo-item-combo">
                      <Combobox value={it.name} options={productOptions} onSelect={(o) => setItems((items) => items.map((x, xi) => (xi === i ? { ...x, sku: o.id, name: o.label } : x)))} placeholder="품목·SKU 검색" ariaLabel="상품" />
                    </div>
                    <input type="number" className="b2b-input promo-item-qty" value={it.qty} onChange={(e) => setItems((items) => items.map((x, xi) => (xi === i ? { ...x, qty: e.target.value } : x)))} aria-label="수량" />
                    <button type="button" className="promo-item-del" onClick={() => setItems((items) => items.filter((_, xi) => xi !== i))} title="삭제">✕</button>
                  </div>
                ))}
                <div className="sm-between" style={{ marginTop: 8 }}>
                  <button type="button" className="promo-item-add" onClick={() => setItems((items) => [...items, { sku: "", name: "", qty: "" }])}>+ 상품 추가</button>
                  {total > 0 && <span className="promo-item-total">합계 <strong>{total.toLocaleString()}개</strong></span>}
                </div>
              </div>
              <div className="b2b-field"><label className="b2b-field-label">메모 (선택)</label>
                <input className="b2b-input" value={draft.note || ""} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="예: 라이브 방송" /></div>
            </>
          )}
        </div>
        {draft && (
          <div className="b2b-modal-foot">
            <div>{draft.id && <button className="b2b-btn-secondary" onClick={() => remove(draft.id!)} disabled={saving} style={{ color: "var(--sm-danger)" }}>삭제</button>}</div>
            <div className="b2b-modal-foot-right">
              <button className="b2b-btn-secondary" onClick={() => { setFieldErr({}); setError(""); setDraft(null); }} disabled={saving}>목록으로 돌아가기</button>
              <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "프로모션 저장"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
