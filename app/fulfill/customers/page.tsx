"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { qtyText } from "@/app/lib/format";
import { CUSTOMER_KINDS, CUSTOMER_KIND_COLOR, type CustomerKind } from "@/app/lib/customer-kind";

// 단골·블랙 고객 — 택배 발주처리 ② 단계에서 이 고객의 주문이 '단골·블랙 고객' 카드로 떠서 확인(체크)해야 CN 파일을 받을 수 있다.
//  등록 기준: 전화(숫자만 저장) → 이름+주소 일부 → 이름만. 메모는 발주 화면에 그대로 보인다.
//  표: fulfill_customers(migration 156). API: /api/fulfill/customers.

type Customer = { id: string; kind: CustomerKind; name: string; phone_digits: string; address: string; memo: string; active: boolean; created_by: string | null; created_at: string; updated_at: string };
type Draft = { kind: CustomerKind; name: string; phone: string; address: string; memo: string };
const EMPTY: Draft = { kind: "블랙", name: "", phone: "", address: "", memo: "" };

function fmtPhone(d: string): string {
  if (!d) return "";
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return d.startsWith("02") ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}
const fmtDate = (iso: string) => (iso ? iso.slice(0, 10) : "");

function KindPill({ kind }: { kind: CustomerKind }) {
  const c = CUSTOMER_KIND_COLOR[kind];
  return <span className="b2b-status-pill" style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>{kind}</span>;
}

export default function CustomersPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<Customer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState<"" | CustomerKind>("");
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const j = await (await fetch("/api/fulfill/customers", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "고객 목록을 불러오지 못했습니다. 새로고침하세요.");
      setList(j.customers || []);
      setMissing(j.missing === true);
      setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "고객 목록을 불러오지 못했습니다. 새로고침하세요."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function startEdit(c: Customer) {
    setEditId(c.id);
    setDraft({ kind: c.kind, name: c.name, phone: fmtPhone(c.phone_digits), address: c.address, memo: c.memo });
    setFieldErr({});
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function cancelEdit() { setEditId(null); setDraft(EMPTY); setFieldErr({}); }

  async function save() {
    if (saving) return;
    const errs: Record<string, string> = {};
    if (!draft.name.trim()) errs.name = "이름을 입력하세요";
    if (Object.keys(errs).length) { setFieldErr(errs); return; }
    setSaving(true);
    setFieldErr({});
    try {
      const body = editId ? { id: editId, ...draft } : draft;
      const j = await (await fetch("/api/fulfill/customers", { method: editId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!j.ok) {
        if (j.fields) setFieldErr(j.fields);
        throw new Error(j.error || "저장하지 못했습니다. 다시 누르세요.");
      }
      const c = j.customer as Customer;
      setList((ls) => (editId ? ls.map((x) => (x.id === c.id ? c : x)) : [c, ...ls]));
      toast.success(editId ? "고객 정보를 저장했습니다" : `${c.kind} 고객을 등록했습니다`);
      cancelEdit();
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했습니다. 다시 누르세요."); }
    setSaving(false);
  }

  async function toggleActive(c: Customer) {
    const next = !c.active;
    setList((ls) => ls.map((x) => (x.id === c.id ? { ...x, active: next } : x)));
    try {
      const j = await (await fetch("/api/fulfill/customers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, active: next }) })).json();
      if (!j.ok) throw new Error(j.error || "저장하지 못했습니다.");
      toast.success(next ? `'${c.name}' 확인을 다시 켰습니다` : `'${c.name}' 확인을 껐습니다 — 발주처리에 뜨지 않습니다`);
    } catch (e) {
      setList((ls) => ls.map((x) => (x.id === c.id ? { ...x, active: c.active } : x)));
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    }
  }

  async function remove(c: Customer) {
    const ok = await confirm({ title: `${c.kind} '${c.name}' 삭제`, body: "목록에서 지워지고 발주처리 확인 카드에 더는 뜨지 않습니다. 잠시 끄려면 삭제 대신 '사용'을 끄세요.", action: "고객 삭제" });
    if (!ok) return;
    try {
      const j = await (await fetch(`/api/fulfill/customers?id=${encodeURIComponent(c.id)}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제하지 못했습니다.");
      setList((ls) => ls.filter((x) => x.id !== c.id));
      if (editId === c.id) cancelEdit();
      toast.success(`'${c.name}'을(를) 삭제했습니다`);
    } catch (e) { setError(e instanceof Error ? e.message : "삭제하지 못했습니다."); }
  }

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
    return list.filter((c) => {
      if (!showInactive && !c.active) return false;
      if (kindFilter && c.kind !== kindFilter) return false;
      if (kw) {
        const hay = `${c.name}${c.phone_digits}${c.address}${c.memo}`.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [list, q, kindFilter, showInactive]);
  const counts = useMemo(() => ({
    블랙: list.filter((c) => c.active && c.kind === "블랙").length,
    단골: list.filter((c) => c.active && c.kind === "단골").length,
  }), [list]);

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    if (fieldErr[k === "phone" ? "phone" : k]) setFieldErr((f) => { const n = { ...f }; delete n[k]; return n; });
  };

  return (
    <div className="b2b-container" style={{ maxWidth: 960 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">단골·블랙 고객</h1>
        </div>
        <div className="b2b-page-actions"><Link className="b2b-btn-secondary" href="/fulfill">발주처리</Link></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {loaded && missing && <div className="b2b-error">고객 등록이 꺼져 있습니다 — supabase/migrations/156_fulfill_customers.sql 을 먼저 적용하세요.</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">{editId ? "고객 수정" : "고객 등록"}</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 10 }}>
          <label className="b2b-field" style={{ margin: 0 }}>
            <span className="b2b-field-label">구분</span>
            <select className="b2b-input" value={draft.kind} onChange={set("kind")} aria-invalid={fieldErr.kind ? "true" : undefined}>
              {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {fieldErr.kind && <div className="b2b-field-error">{fieldErr.kind}</div>}
          </label>
          <label className="b2b-field" style={{ margin: 0 }}>
            <span className="b2b-field-label">이름</span>
            <input className="b2b-input" value={draft.name} onChange={set("name")} placeholder="홍길동" aria-invalid={fieldErr.name ? "true" : undefined} />
            {fieldErr.name && <div className="b2b-field-error">{fieldErr.name}</div>}
          </label>
          <label className="b2b-field" style={{ margin: 0 }}>
            <span className="b2b-field-label">전화 <span className="opt">선택 — 있으면 전화로 먼저 찾는다</span></span>
            <input className="b2b-input" value={draft.phone} onChange={set("phone")} placeholder="010-0000-0000" inputMode="tel" aria-invalid={fieldErr.phone ? "true" : undefined} />
            {fieldErr.phone && <div className="b2b-field-error">{fieldErr.phone}</div>}
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginTop: 10 }}>
          <label className="b2b-field" style={{ margin: 0 }}>
            <span className="b2b-field-label">주소 일부 <span className="opt">선택 — 이름이 같고 이 글자가 주소에 있으면 일치</span></span>
            <input className="b2b-input" value={draft.address} onChange={set("address")} placeholder="래미안 101동" aria-invalid={fieldErr.address ? "true" : undefined} />
            {fieldErr.address && <div className="b2b-field-error">{fieldErr.address}</div>}
          </label>
          <label className="b2b-field" style={{ margin: 0 }}>
            <span className="b2b-field-label">메모 <span className="opt">발주 화면에 그대로 보인다</span></span>
            <input className="b2b-input" value={draft.memo} onChange={set("memo")} placeholder="반품 3회 — 발송 전 전화 확인" aria-invalid={fieldErr.memo ? "true" : undefined} />
            {fieldErr.memo && <div className="b2b-field-error">{fieldErr.memo}</div>}
          </label>
        </div>
        <div className="sm-row" style={{ gap: 8, marginTop: 12 }}>
          <button className="b2b-btn-primary" onClick={save} disabled={saving || missing}>{editId ? "변경 저장" : "고객 등록"}</button>
          {editId && <button className="b2b-btn-secondary" onClick={cancelEdit} disabled={saving}>그만두기</button>}
          {missing && <span className="b2b-btn-why">156 적용 뒤 등록할 수 있습니다</span>}
        </div>
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head">
          <span className="b2b-card-title">고객 목록 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>블랙 {qtyText(counts.블랙)} · 단골 {qtyText(counts.단골)}</span></span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <input className="b2b-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색" aria-label="이름·전화·주소·메모 검색" style={{ flex: "1 1 220px" }} />
          <select className="b2b-input" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as "" | CustomerKind)} aria-label="구분" style={{ width: 110 }}>
            <option value="">전체</option>
            {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 사용 안 함 표시
          </label>
        </div>
        {!loaded ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : shown.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 18 }}>{list.length === 0 ? "등록된 고객이 없습니다. 위에서 고객을 등록하세요." : "조건에 맞는 고객이 없습니다. 검색어·구분을 지우세요."}</div>
        ) : (
          <div className="b2b-table-wrap is-sticky-head">
            <table className="b2b-table">
              <thead><tr><th style={{ width: 70 }}>구분</th><th>이름</th><th>전화</th><th>주소 일부</th><th>메모</th><th style={{ width: 110 }}>등록</th><th style={{ width: 60 }}>사용</th><th style={{ width: 130 }}></th></tr></thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                    <td><KindPill kind={c.kind} /></td>
                    <td><strong>{c.name}</strong></td>
                    <td className="sm-faint">{fmtPhone(c.phone_digits) || "-"}</td>
                    <td className="sm-faint">{c.address || "-"}</td>
                    <td style={{ whiteSpace: "pre-wrap" }}>{c.memo || "-"}</td>
                    <td className="sm-faint" style={{ fontSize: 12 }}>{c.created_by || "-"}<br />{fmtDate(c.created_at)}</td>
                    <td><input type="checkbox" checked={c.active} onChange={() => toggleActive(c)} aria-label={`${c.name} 사용`} /></td>
                    <td className="actions">
                      <div className="sm-row" style={{ gap: 6, justifyContent: "flex-end" }}>
                        <button className="b2b-btn-secondary" style={{ padding: "2px 9px" }} onClick={() => startEdit(c)}>수정</button>
                        <button className="b2b-btn-danger" style={{ padding: "2px 9px" }} onClick={() => remove(c)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>발주처리 ② 단계에서 찾는 순서: 전화 일치 → 이름이 같고 주소 일부가 주문 주소에 포함 → 이름만(주소를 안 적었고, 전화를 안 적었거나 주문에 전화가 없을 때). 전화는 숫자만 저장됩니다.</p>
      </section>
    </div>
  );
}
