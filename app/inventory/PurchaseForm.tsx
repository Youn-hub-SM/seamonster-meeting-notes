"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signedQty, type InvTxnType, type InvChannel } from "@/app/lib/inventory";
import { matchKoQuery } from "@/app/lib/hangul";
import { ChannelPicker } from "./ChannelTabs";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export type PickProduct = { id: string; name: string; sku: string | null; spec: string | null; unit: string; cost_price: number; purchase_price: number; origin: string | null; attrs: string | null; qty: number };
type Line = { key: string; product_id: string; name: string; sub: string; unit: string; qty: string; price: string };

// BoxHero 구매창 스타일 — 전체 페이지 폼. 여러 제품을 담아 입고/출고를 한 번에. 제품 검색은 초성·다중단어 지원.
export default function PurchaseForm({ products, defaultType = "입고", onSaved, onCancel }: {
  products: PickProduct[];
  defaultType?: InvTxnType;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<InvTxnType>(defaultType);
  const [channel, setChannel] = useState<InvChannel>("소매");
  const [date, setDate] = useState(TODAY());
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState(true); // 즉시 입고/출고처리(기본 체크) — 해제 시 '대기'
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1); // 키보드 하이라이트 인덱스
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const suggestRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    return products.filter((p) => matchKoQuery(`${p.name} ${p.sku || ""} ${p.spec || ""} ${p.origin || ""} ${p.attrs || ""} ${p.unit}`, q)).slice(0, 12);
  }, [products, search]);

  // 활성 항목을 보이게 스크롤
  useEffect(() => { suggestRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" }); }, [active]);

  function addLine(p: PickProduct) {
    const sub = [p.spec, p.origin, p.attrs, p.sku, `재고 ${p.qty.toLocaleString()}${p.unit}`].filter(Boolean).join(" · ");
    // 입고 = 상품 마스터의 '매입단가' 기준(미설정이면 빈칸 — 원가로 채우지 않음). 출고 = 원가 참고가.
    const base = type === "입고" ? p.purchase_price : p.cost_price;
    setLines((ls) => [...ls, { key: `${p.id}-${ls.length}-${Date.now()}`, product_id: p.id, name: p.name, sub, unit: p.unit, qty: "1", price: base ? String(base) : "" }]);
    setSearch(""); setActive(-1);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0 && matches[active]) addLine(matches[active]); else if (matches.length === 1) addLine(matches[0]); }
    else if (e.key === "Escape") { setSearch(""); setActive(-1); }
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
      const res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, done, channel }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  return (
    <>
      <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="sm-tabs">
          <button className={`sm-tab ${type === "입고" ? "is-active" : ""}`} onClick={() => setType("입고")}>구매(입고)</button>
          <button className={`sm-tab ${type === "출고" ? "is-active" : ""}`} onClick={() => setType("출고")}>판매(출고)</button>
        </div>
        <ChannelPicker value={channel} onChange={setChannel} />
        <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>거래일
          <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} /></label>
        <input className="b2b-input" placeholder={type === "입고" ? "매입처(선택)" : "판매처(선택)"} value={partner} onChange={(e) => setPartner(e.target.value)} style={{ width: 170 }} />
        <input className="b2b-input" placeholder="메모(선택)" value={memo} onChange={(e) => setMemo(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
      </div>

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">제품 선택</span></div>

        {/* 큰 검색창 — 이름·옵션·SKU·초성·여러 단어("광어 100 1kg") */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <input className="b2b-input" value={search} onChange={(e) => { setSearch(e.target.value); setActive(-1); }} onKeyDown={onSearchKey} autoComplete="off"
            placeholder="제품 검색 — 예: 광어 100 1kg / 초성 ㄱㅇ  (↓↑ 이동, Enter 추가)"
            style={{ fontSize: 15, padding: "13px 16px" }} />
          {matches.length > 0 && (
            <div className="inv-buy-suggest" ref={suggestRef}>
              {matches.map((p, i) => (
                <button key={p.id} className={`inv-buy-suggest-item ${i === active ? "is-active" : ""}`} onClick={() => addLine(p)} onMouseEnter={() => setActive(i)}>
                  <span><strong>{p.name}</strong> <span className="sm-faint" style={{ fontSize: 12 }}>{[p.spec, p.origin, p.attrs, p.sku].filter(Boolean).join(" · ")}</span></span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>재고 {p.qty.toLocaleString()}{p.unit}</span>
                </button>
              ))}
            </div>
          )}
          {search.trim() && matches.length === 0 && <div className="inv-buy-suggest"><div className="sm-faint" style={{ padding: "10px 14px", fontSize: 13 }}>일치하는 제품 없음</div></div>}
        </div>

        <div className="b2b-table-wrap">
          <table className="b2b-table inv-buy-table">
            <thead><tr><th>제품</th><th className="num" style={{ width: 100 }}>수량</th><th className="num" style={{ width: 140 }}>단가</th><th className="num" style={{ width: 130 }}>금액</th><th style={{ width: 40 }}></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><strong>{l.name}</strong>{l.sub && <div className="sm-faint" style={{ fontSize: 11 }}>{l.sub}</div>}</td>
                  <td className="num"><input className="b2b-input" type="number" min={1} value={l.qty} onChange={(e) => setLine(l.key, "qty", e.target.value)} style={{ width: 80, textAlign: "right", padding: "6px 8px" }} /></td>
                  <td className="num"><input className="b2b-input" type="number" min={0} value={l.price} onChange={(e) => setLine(l.key, "price", e.target.value)} style={{ width: 120, textAlign: "right", padding: "6px 8px" }} /></td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}>₩{amountOf(l).toLocaleString()}</td>
                  <td><button className="b2b-link-btn" onClick={() => removeLine(l.key)} style={{ color: "var(--sm-text-light)" }} aria-label="삭제">✕</button></td>
                </tr>
              ))}
              {lines.length === 0 && <tr><td colSpan={5} className="sm-faint" style={{ padding: "16px 4px" }}>위 검색창에서 제품을 찾아 추가하세요.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="sm-between" style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--sm-border)", flexWrap: "wrap", gap: 12 }}>
          <span className="sm-faint" style={{ fontSize: 13 }}>{totals.items}개 품목 · 총 {totals.qty.toLocaleString()}개</span>
          <span style={{ fontSize: 19, fontWeight: 800 }}>총액 ₩{totals.amount.toLocaleString()}</span>
        </div>
      </section>

      {error && <div className="b2b-error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="sm-between" style={{ marginTop: 16, gap: 10, flexWrap: "wrap" }}>
        <label className="sm-row" style={{ gap: 7, fontSize: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> 즉시 {type === "입고" ? "입고" : "출고"}처리 <span className="sm-faint" style={{ fontSize: 12 }}>(해제 시 ‘대기’로 저장)</span>
        </label>
        <div className="sm-row" style={{ gap: 10 }}>
          <button className="b2b-btn-secondary" onClick={onCancel} disabled={saving}>취소</button>
          <button className="b2b-btn-primary" onClick={save} disabled={saving || totals.items === 0}>{saving ? "저장 중…" : (done ? `${type === "입고" ? "구매" : "판매"} 저장` : "대기로 저장")}</button>
        </div>
      </div>
    </>
  );
}
