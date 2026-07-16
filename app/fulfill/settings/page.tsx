"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DEFAULT_RATES, DEFAULT_EFFECTIVE, type RateVersion, type BoxTier } from "@/app/lib/fulfill-rates";

const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export default function FulfillSettingsPage() {
  const [history, setHistory] = useState<RateVersion[]>([{ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    fetch("/api/fulfill/rates", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok && j.history?.length) setHistory(j.history); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // 오늘 적용 중인 버전의 인덱스 (적용일이 오늘 이하인 것 중 가장 최근; 없으면 가장 이른 것)
  const activeIdx = useMemo(() => {
    const today = kstToday();
    let best = -1, bestDate = "";
    history.forEach((v, i) => { if (v.effectiveFrom <= today && v.effectiveFrom >= bestDate) { best = i; bestDate = v.effectiveFrom; } });
    if (best !== -1) return best;
    return history.reduce((mi, v, i, a) => (v.effectiveFrom < a[mi].effectiveFrom ? i : mi), 0);
  }, [history]);

  async function save() {
    setSaving(true); setError(""); setOk("");
    try {
      const res = await fetch("/api/fulfill/rates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versions: history }) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error || "저장 실패");
      setHistory(j.history); setOk("저장했어요. 각 날짜의 배송일지는 그 날짜에 유효했던 단가로 계산됩니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  const patch = (idx: number, fn: (v: RateVersion) => RateVersion) => setHistory((h) => h.map((v, i) => (i === idx ? fn(v) : v)));
  const setDate = (idx: number, d: string) => patch(idx, (v) => ({ ...v, effectiveFrom: d || DEFAULT_EFFECTIVE }));
  const addVersion = () => setHistory((h) => {
    const base = h[h.length - 1] ?? { ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE };
    return [...h, { ...base, boxTiers: base.boxTiers.map((t) => ({ ...t })), supplies: base.supplies.map((s) => ({ ...s })), effectiveFrom: kstToday() }];
  });
  const delVersion = (idx: number) => setHistory((h) => (h.length <= 1 ? h : h.filter((_, i) => i !== idx)));

  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">택배 단가 설정</h1>
          <p className="b2b-page-subtitle">단가는 적용 시작일별로 관리 — 소급 적용되지 않습니다</p>
        </div>
        <div className="b2b-page-actions"><button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>{saving ? "저장 중…" : "저장"}</button></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="sm-success">✓ {ok}</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : (
        <>
          <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <span className="sm-faint" style={{ fontSize: 12 }}>단가 이력 {history.length}개 · 이미 기록된 배송일지의 기본운임·도착보장 운임은 발주처리 시점에 <strong>박제</strong>되어 바뀌지 않습니다(드라이·표시 단가만 날짜별 반영).</span>
            <button className="b2b-btn-secondary" style={{ padding: "6px 14px" }} onClick={addVersion}>+ 새 단가 (적용일부터)</button>
          </div>

          {history.map((v, idx) => (
            <VersionCard
              key={idx}
              v={v}
              active={idx === activeIdx}
              canDelete={history.length > 1}
              onDate={(d) => setDate(idx, d)}
              onPatch={(fn) => patch(idx, fn)}
              onDelete={() => delVersion(idx)}
              num={num}
            />
          ))}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
          </div>
        </>
      )}
    </div>
  );
}

function VersionCard({ v, active, canDelete, onDate, onPatch, onDelete, num }: {
  v: RateVersion; active: boolean; canDelete: boolean;
  onDate: (d: string) => void; onPatch: (fn: (v: RateVersion) => RateVersion) => void; onDelete: () => void; num: (v: string) => number;
}) {
  const bounded = v.boxTiers.filter((t) => t.maxKg !== null);
  const over = v.boxTiers.find((t) => t.maxKg === null) ?? { maxKg: null, fee: 0 };
  const setTiers = (tiers: BoxTier[]) => onPatch((x) => ({ ...x, boxTiers: tiers }));
  const setBounded = (i: number, p: Partial<BoxTier>) => setTiers([...bounded.map((t, j) => (j === i ? { ...t, ...p } : t)), { maxKg: null, fee: over.fee }]);
  const addTier = () => setTiers([...bounded, { maxKg: (bounded.at(-1)?.maxKg ?? 0) + 1, fee: over.fee }, { maxKg: null, fee: over.fee }]);
  const delTier = (i: number) => setTiers([...bounded.filter((_, j) => j !== i), { maxKg: null, fee: over.fee }]);
  const setOverFee = (fee: number) => setTiers([...bounded, { maxKg: null, fee }]);

  return (
    <section className="b2b-card" style={{ marginBottom: 16 }}>
      <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="b2b-card-title">적용 시작일</span>
          <input type="date" className="b2b-input" value={v.effectiveFrom === DEFAULT_EFFECTIVE ? "" : v.effectiveFrom} onChange={(e) => onDate(e.target.value)} style={{ width: "auto" }} />
          {v.effectiveFrom === DEFAULT_EFFECTIVE && <span className="sm-faint" style={{ fontSize: 12 }}>(미지정 = 처음부터)</span>}
          {active && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--sm-orange)", border: "1px solid var(--sm-orange)", borderRadius: 999, padding: "1px 8px" }}>현재 적용 중</span>}
        </div>
        {canDelete && <button className="b2b-link-btn" onClick={onDelete} style={{ color: "var(--sm-danger)" }}>이 단가 삭제</button>}
      </div>

      {/* 택배 기본운임 구간 */}
      <div style={{ marginTop: 4 }}>
        <div className="sm-faint" style={{ fontSize: 12, fontWeight: 700, margin: "6px 0 4px" }}>택배 기본운임 (주문 총중량 구간)</div>
        <p className="sm-faint" style={{ fontSize: 11.5, marginBottom: 6 }}>한 주문(같은 주소)의 총중량으로 박스타입·기본운임이 정해집니다. 일반·도착보장 공통이며, 도착보장은 아래 &lsquo;박스당 추가운임&rsquo;이 더해집니다.</p>
        <div className="b2b-table-wrap">
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
        </div>
        <button className="b2b-btn-secondary" style={{ marginTop: 8, padding: "5px 12px", fontSize: 12 }} onClick={addTier}>+ 구간 추가</button>
      </div>

      {/* 도착보장 + 드라이아이스 */}
      <div className="b2b-field-row" style={{ marginTop: 12 }}>
        <label className="b2b-field"><span className="b2b-field-label">도착보장 박스당 추가운임 (원)</span>
          <input type="number" className="b2b-input b2b-money" value={v.guarSurcharge} onChange={(e) => onPatch((x) => ({ ...x, guarSurcharge: num(e.target.value) }))} style={{ maxWidth: 140 }} />
        </label>
        <label className="b2b-field"><span className="b2b-field-label">드라이아이스 1박스 (원)</span>
          <input type="number" className="b2b-input b2b-money" value={v.dryFull} onChange={(e) => onPatch((x) => ({ ...x, dryFull: num(e.target.value) }))} style={{ maxWidth: 140 }} />
        </label>
        <label className="b2b-field"><span className="b2b-field-label">드라이아이스 1/2박스 (원)</span>
          <input type="number" className="b2b-input b2b-money" value={v.dryHalf} onChange={(e) => onPatch((x) => ({ ...x, dryHalf: num(e.target.value) }))} style={{ maxWidth: 140 }} />
        </label>
      </div>

      {/* 부자재 단가 */}
      <div style={{ marginTop: 12 }}>
        <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span className="sm-faint" style={{ fontSize: 12, fontWeight: 700 }}>박스·부자재 단가</span>
          <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onPatch((x) => ({ ...x, supplies: [...x.supplies, { name: "", price: 0 }] }))}>+ 항목 추가</button>
        </div>
        {v.supplies.length === 0 ? (
          <p className="sm-faint" style={{ fontSize: 12.5, padding: "2px 0" }}>박스·비닐·완충재 등 자주 쓰는 부자재의 단가를 등록해 두세요.</p>
        ) : (
          <div className="sm-col" style={{ gap: 6 }}>
            {v.supplies.map((s, i) => (
              <div key={i} className="sm-row" style={{ gap: 8, alignItems: "center" }}>
                <input className="b2b-input" placeholder="이름 (예: 박스 大)" value={s.name} onChange={(e) => onPatch((x) => ({ ...x, supplies: x.supplies.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) }))} style={{ flex: 1 }} />
                <input type="number" className="b2b-input b2b-money" placeholder="단가" value={s.price || ""} onChange={(e) => onPatch((x) => ({ ...x, supplies: x.supplies.map((y, j) => (j === i ? { ...y, price: num(e.target.value) } : y)) }))} style={{ width: 120 }} />
                <button className="b2b-link-btn" onClick={() => onPatch((x) => ({ ...x, supplies: x.supplies.filter((_, j) => j !== i) }))} style={{ color: "var(--sm-danger)" }}>삭제</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
