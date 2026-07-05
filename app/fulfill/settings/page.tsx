"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DEFAULT_RATES, type FulfillRates, type BoxTier, type Supply } from "@/app/lib/fulfill-rates";

export default function FulfillSettingsPage() {
  const [rates, setRates] = useState<FulfillRates>(DEFAULT_RATES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    fetch("/api/fulfill/rates", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setRates(j.rates); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true); setError(""); setOk("");
    try {
      const res = await fetch("/api/fulfill/rates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rates) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error || "저장 실패");
      setRates(j.rates); setOk("저장했어요. 발주처리·배송일지에 즉시 반영됩니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  // 구간(마지막은 초과=maxKg null 유지)
  const bounded = rates.boxTiers.filter((t) => t.maxKg !== null);
  const over = rates.boxTiers.find((t) => t.maxKg === null) ?? { maxKg: null, fee: 0 };
  const setTiers = (tiers: BoxTier[]) => setRates((r) => ({ ...r, boxTiers: tiers }));
  const setBounded = (i: number, patch: Partial<BoxTier>) => { const b = bounded.map((t, j) => (j === i ? { ...t, ...patch } : t)); setTiers([...b, { maxKg: null, fee: over.fee }]); };
  const addTier = () => setTiers([...bounded, { maxKg: (bounded.at(-1)?.maxKg ?? 0) + 1, fee: over.fee }, { maxKg: null, fee: over.fee }]);
  const delTier = (i: number) => setTiers([...bounded.filter((_, j) => j !== i), { maxKg: null, fee: over.fee }]);
  const setOverFee = (fee: number) => setTiers([...bounded, { maxKg: null, fee }]);

  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">택배 단가 설정</h1>
          <p className="b2b-page-subtitle">택배 기본운임·도착보장 추가운임·드라이아이스·부자재 단가를 여기서 바꾸면 <Link href="/fulfill">발주처리</Link>·<Link href="/fulfill/log">배송일지</Link> 계산에 바로 반영됩니다.</p>
        </div>
        <div className="b2b-page-actions"><button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>{saving ? "저장 중…" : "저장"}</button></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="prod-sku-ok" style={{ fontSize: 13, marginBottom: 12 }}>✓ {ok}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          {/* 택배 기본운임 구간 */}
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">택배 기본운임 (주문 총중량 구간)</span></div>
            <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>한 주문(같은 주소)의 총중량으로 박스타입·기본운임이 정해집니다. 일반·도착보장 공통 기본운임이며, 도착보장은 아래 &lsquo;박스당 추가운임&rsquo;이 더해집니다.</p>
            <table className="b2b-table" style={{ fontSize: 13 }}>
              <thead><tr><th>박스타입</th><th className="num">이하(kg)</th><th className="num">기본운임(원)</th><th></th></tr></thead>
              <tbody>
                {bounded.map((t, i) => (
                  <tr key={i}>
                    <td>타입 {i + 1}</td>
                    <td className="num"><input type="number" step="0.1" className="b2b-input b2b-money" style={{ width: 90 }} value={t.maxKg ?? ""} onChange={(e) => setBounded(i, { maxKg: Number(e.target.value) || 0 })} /></td>
                    <td className="num"><input type="number" className="b2b-input b2b-money" style={{ width: 100 }} value={t.fee} onChange={(e) => setBounded(i, { fee: num(e.target.value) })} /></td>
                    <td><button className="b2b-link-btn" onClick={() => delTier(i)} style={{ color: "var(--sm-danger)" }}>삭제</button></td>
                  </tr>
                ))}
                <tr>
                  <td>타입 {bounded.length + 1}</td>
                  <td className="num sm-faint">초과</td>
                  <td className="num"><input type="number" className="b2b-input b2b-money" style={{ width: 100 }} value={over.fee} onChange={(e) => setOverFee(num(e.target.value))} /></td>
                  <td />
                </tr>
              </tbody>
            </table>
            <button className="b2b-btn-secondary" style={{ marginTop: 8, padding: "5px 12px", fontSize: 12 }} onClick={addTier}>+ 구간 추가</button>
          </section>

          {/* 도착보장 추가운임 + 드라이아이스 */}
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">도착보장 · 드라이아이스</span></div>
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">도착보장 박스당 추가운임 (원)</span>
                <input type="number" className="b2b-input b2b-money" value={rates.guarSurcharge} onChange={(e) => setRates((r) => ({ ...r, guarSurcharge: num(e.target.value) }))} style={{ maxWidth: 140 }} />
              </label>
            </div>
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">드라이아이스 1박스 (원)</span>
                <input type="number" className="b2b-input b2b-money" value={rates.dryFull} onChange={(e) => setRates((r) => ({ ...r, dryFull: num(e.target.value) }))} style={{ maxWidth: 140 }} />
              </label>
              <label className="b2b-field"><span className="b2b-field-label">드라이아이스 1/2박스 (원)</span>
                <input type="number" className="b2b-input b2b-money" value={rates.dryHalf} onChange={(e) => setRates((r) => ({ ...r, dryHalf: num(e.target.value) }))} style={{ maxWidth: 140 }} />
              </label>
            </div>
          </section>

          {/* 부자재 단가 */}
          <section className="b2b-card">
            <div className="b2b-card-head" style={{ justifyContent: "space-between" }}>
              <span className="b2b-card-title">박스·부자재 단가</span>
              <button className="b2b-btn-secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setRates((r) => ({ ...r, supplies: [...r.supplies, { name: "", price: 0 }] }))}>+ 항목 추가</button>
            </div>
            {rates.supplies.length === 0 ? (
              <p className="sm-faint" style={{ fontSize: 13, padding: "6px 0" }}>박스·비닐·완충재 등 자주 쓰는 부자재의 단가를 등록해 두세요.</p>
            ) : (
              <div className="sm-col" style={{ gap: 6 }}>
                {rates.supplies.map((s, i) => (
                  <div key={i} className="sm-row" style={{ gap: 8, alignItems: "center" }}>
                    <input className="b2b-input" placeholder="이름 (예: 박스 大)" value={s.name} onChange={(e) => setRates((r) => ({ ...r, supplies: r.supplies.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} style={{ flex: 1 }} />
                    <input type="number" className="b2b-input b2b-money" placeholder="단가" value={s.price || ""} onChange={(e) => setRates((r) => ({ ...r, supplies: r.supplies.map((x, j) => (j === i ? { ...x, price: num(e.target.value) } : x)) }))} style={{ width: 120 }} />
                    <button className="b2b-link-btn" onClick={() => setRates((r) => ({ ...r, supplies: r.supplies.filter((_, j) => j !== i) }))} style={{ color: "var(--sm-danger)" }}>삭제</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
          </div>
        </>
      )}
    </div>
  );
}
