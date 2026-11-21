"use client";

// 급여 항목 — 직접 넣는 지급·공제 항목(식대·상여·정산 등). 근무대장에서 나오는 지급과 법정 공제는 자동이라 여기 없다.
//  항목은 지우지 않는다(지난 급여대장에 이름이 남아 있다) — 쓰지 않으려면 '사용'을 끈다.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { ITEM_TAX_KINDS, ITEM_TAX_LABEL, SYSTEM_DEDUCT, SYSTEM_LABEL, SYSTEM_PAY, type ItemTaxKind, type PayItemDef } from "@/app/lib/hr-pay";
import { HrApiError, errText, hrApi } from "../../api";

export default function HrPayItemsPage() {
  const toast = useToast();
  const [items, setItems] = useState<PayItemDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ item: PayItemDef | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      setItems((await hrApi<{ items: PayItemDef[] }>("/api/hr/pay-items")).items);
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "급여 항목을 불러오지 못했습니다."));
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(i: PayItemDef) {
    try {
      const j = await hrApi<{ item: PayItemDef }>("/api/hr/pay-items", "PATCH", { id: i.id, active: !i.active });
      setItems((p) => p.map((x) => (x.id === i.id ? j.item : x)));
      toast.success(j.item.active ? `${i.name} 항목을 다시 씁니다` : `${i.name} 항목을 쓰지 않습니다`);
    } catch (err) { toast.error(errText(err, "급여 항목을 저장하지 못했습니다.")); }
  }

  return (
    <div className="b2b-container">
      <Link href="/hr/pay" className="sm-link hr-back">급여</Link>
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">급여 항목</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-primary" disabled={loading || !!error} onClick={() => setEdit({ item: null })}>항목 추가</button>
        </div>
      </header>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : (
        <>
          <p className="hr-rule">
            자동 항목: {SYSTEM_PAY.map((c) => SYSTEM_LABEL[c]).join("·")}(근무대장에서 계산), {SYSTEM_DEDUCT.map((c) => SYSTEM_LABEL[c]).join("·")}(요율·간이세액표로 계산).
          </p>
          <div className="b2b-table-wrap">
            <table className="b2b-table hr-table">
              <thead><tr><th>항목</th><th>구분</th><th>과세</th><th>입력</th><th>상태</th><th></th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.name}</strong></td>
                    <td>{i.kind === "pay" ? "지급" : "공제"}</td>
                    <td>{i.kind === "pay" ? ITEM_TAX_LABEL[i.tax] : ""}</td>
                    <td>{i.fixed ? "매월 고정" : "그때 입력"}</td>
                    <td><span className={`b2b-status-pill ${i.active ? "hr-pill-ok" : "hr-pill-off"}`}>{i.active ? "사용" : "중지"}</span></td>
                    <td className="actions">
                      <button type="button" className="b2b-link-btn" onClick={() => setEdit({ item: i })}>항목 수정</button>
                      <button type="button" className="b2b-link-btn" onClick={() => toggle(i)}>{i.active ? "사용 중지" : "다시 사용"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {edit && (
        <ItemForm item={edit.item} onClose={() => setEdit(null)}
          onSaved={(saved) => {
            setEdit(null);
            setItems((p) => (p.some((x) => x.id === saved.id) ? p.map((x) => (x.id === saved.id ? saved : x)) : [...p, saved]));
            toast.success(edit.item ? "급여 항목을 저장했습니다" : "급여 항목을 추가했습니다");
          }} />
      )}
    </div>
  );
}

function ItemForm({ item, onClose, onSaved }: { item: PayItemDef | null; onClose: () => void; onSaved: (i: PayItemDef) => void }) {
  const [f, setF] = useState({ name: item?.name || "", kind: item?.kind || ("pay" as "pay" | "deduct"), tax: item?.tax || ("taxable" as ItemTaxKind), fixed: item?.fixed ?? false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);

  async function save() {
    if (!f.name.trim()) { setErrors({ name: "항목 이름을 입력하세요" }); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError(""); setErrors({});
    try {
      const j = await hrApi<{ item: PayItemDef }>("/api/hr/pay-items", item ? "PATCH" : "POST", { ...f, ...(item ? { id: item.id } : {}) });
      onSaved(j.item);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("급여 항목을 저장하지 못했습니다.");
      setBusy(false);
    }
  }
  const title = item ? `${item.name} 수정` : "항목 추가";

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label={title}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{title}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <label className="b2b-field hr-wide">
                <span className="b2b-field-label">항목 이름<span className="req">*</span></span>
                <input className="b2b-input" value={f.name} maxLength={30} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} aria-invalid={errors.name ? "true" : undefined} />
                {errors.name && <span className="b2b-field-error">{errors.name}</span>}
              </label>
              <div className="b2b-field">
                <span className="b2b-field-label">구분</span>
                <div className="sm-tabs">
                  <button type="button" className={`sm-tab ${f.kind === "pay" ? "is-active" : ""}`} onClick={() => setF((p) => ({ ...p, kind: "pay" }))}>지급</button>
                  <button type="button" className={`sm-tab ${f.kind === "deduct" ? "is-active" : ""}`} onClick={() => setF((p) => ({ ...p, kind: "deduct", tax: "taxable" }))}>공제</button>
                </div>
              </div>
              {f.kind === "pay" && (
                <label className="b2b-field">
                  <span className="b2b-field-label">과세</span>
                  <select className="b2b-input" value={f.tax} onChange={(e) => setF((p) => ({ ...p, tax: e.target.value as ItemTaxKind }))}>
                    {ITEM_TAX_KINDS.map((k) => <option key={k} value={k}>{ITEM_TAX_LABEL[k]}</option>)}
                  </select>
                </label>
              )}
              <div className="b2b-field">
                <span className="b2b-field-label">입력</span>
                <div className="sm-tabs">
                  <button type="button" className={`sm-tab ${f.fixed ? "is-active" : ""}`} onClick={() => setF((p) => ({ ...p, fixed: true }))}>매월 고정</button>
                  <button type="button" className={`sm-tab ${!f.fixed ? "is-active" : ""}`} onClick={() => setF((p) => ({ ...p, fixed: false }))}>그때 입력</button>
                </div>
              </div>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : item ? "변경 저장" : "항목 추가"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
