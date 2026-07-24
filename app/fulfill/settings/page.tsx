"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DEFAULT_RATES, DEFAULT_EFFECTIVE, DEFAULT_BOX_CATS, validateBoxCats, type RateVersion, type BoxTier, type BoxCat } from "@/app/lib/fulfill-rates";
import { DEDUP_DEFAULT, type DedupConfig, type DedupMatch } from "@/app/lib/fulfill-dedup";

const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export default function FulfillSettingsPage() {
  const [history, setHistory] = useState<RateVersion[]>([{ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE }]);
  const [boxCats, setBoxCats] = useState<BoxCat[]>(DEFAULT_BOX_CATS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  // 중복 방지 설정
  const [dedup, setDedup] = useState<DedupConfig>(DEDUP_DEFAULT);
  const [processedCount, setProcessedCount] = useState<number | null>(null);
  const [dedupSaving, setDedupSaving] = useState(false);
  const [dedupMsg, setDedupMsg] = useState("");

  useEffect(() => {
    fetch("/api/fulfill/rates", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok && j.history?.length) setHistory(j.history); if (j.ok && Array.isArray(j.boxCats) && j.boxCats.length) setBoxCats(j.boxCats); }).catch(() => {}).finally(() => setLoading(false));
    fetch("/api/fulfill/dedup", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) { setDedup(j.config); setProcessedCount(j.processedCount); } }).catch(() => {});
  }, []);

  async function saveDedup() {
    setDedupSaving(true); setDedupMsg("");
    try {
      const r = await fetch("/api/fulfill/dedup", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dedup) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || "저장 실패");
      setDedup(j.config); setDedupMsg("저장됨");
    } catch (e) { setDedupMsg(e instanceof Error ? e.message : "저장 실패"); }
    setDedupSaving(false);
  }
  async function clearProcessed() {
    if (!window.confirm("처리완료 주문 기록을 모두 지울까요?\n중복 판정 기준이 비워집니다(재고·배송일지에는 영향 없음). 이후 출고 완료분부터 다시 쌓입니다.")) return;
    setDedupSaving(true); setDedupMsg("");
    try {
      const r = await fetch("/api/fulfill/dedup", { method: "DELETE" });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || "초기화 실패");
      setProcessedCount(0); setDedupMsg("처리완료 기록을 비웠습니다");
    } catch (e) { setDedupMsg(e instanceof Error ? e.message : "초기화 실패"); }
    setDedupSaving(false);
  }

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
      const res = await fetch("/api/fulfill/rates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versions: history, boxCats }) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error || "저장 실패");
      setHistory(j.history); if (Array.isArray(j.boxCats) && j.boxCats.length) setBoxCats(j.boxCats);
      setOk("저장했어요. 각 날짜의 배송일지는 그 날짜에 유효했던 단가로 계산됩니다.");
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
          <h1 className="b2b-page-title">온라인 발주 설정</h1>
        </div>
        <div className="b2b-page-actions"><button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>{saving ? "저장 중…" : "저장"}</button></div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="sm-success">✓ {ok}</div>}

      {/* 배송일지 박스 종류 — 택배량 집계 단위 */}
      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">배송일지 박스 종류 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>· 택배량을 세는 단위</span></span></div>
        <p className="sm-faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
          주문 총중량이 어느 구간에 드는지로 박스 종류가 정해집니다. 이름과 이하(kg)를 바꿀 수 있고, 마지막 종류는 항상 &lsquo;초과&rsquo;입니다.
          한 종류가 위 <strong>기본운임 구간 경계</strong>를 걸치면 저장되지 않습니다(같은 종류인데 운임이 달라져 배송일지 수정 시 금액이 어긋남).
        </p>
        <table className="b2b-table" style={{ fontSize: 13 }}>
          <thead><tr><th>박스 종류</th><th className="num">이하(kg)</th><th style={{ width: 40 }}></th></tr></thead>
          <tbody>
            {boxCats.map((c, i) => (
              <tr key={i}>
                <td><input className="b2b-input" style={{ width: 140 }} value={c.name}
                  onChange={(e) => setBoxCats((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                <td className="num">{c.maxKg == null ? <span className="sm-faint">초과(무제한)</span> : (
                  <input type="number" step="0.1" className="b2b-input b2b-money" style={{ width: 90 }} value={c.maxKg}
                    onChange={(e) => setBoxCats((cs) => cs.map((x, j) => (j === i ? { ...x, maxKg: Number(e.target.value) || 0 } : x)))} />
                )}</td>
                <td>{boxCats.length > 1 && (
                  <button className="b2b-link-btn" style={{ color: "var(--sm-text-light)" }} aria-label="삭제"
                    onClick={() => {
                      // 기본 8종은 대표중량 폴백이 있어 과거 보정분 운임이 유지되지만, 직접 만든 종류는 환산액이 0원이 된다.
                      const known = DEFAULT_BOX_CATS.some((d) => d.name === c.name);
                      const msg = `'${c.name}' 을 목록에서 뺄까요?\n\n`
                        + `과거 배송일지의 이 종류 기록(수량·직접수정 내역)은 그대로 남고 표·엑셀에도 계속 보입니다.\n`
                        + `새 발주처리에서는 더 이상 이 종류로 분류되지 않습니다.`
                        + (known ? "" : "\n\n※ 직접 추가한 종류라, 이 종류로 된 직접수정 보정의 운임 환산액은 0원이 됩니다(수량은 유지).");
                      if (!window.confirm(msg)) return;
                      setBoxCats((cs) => { const next = cs.filter((_, j) => j !== i); next[next.length - 1] = { ...next[next.length - 1], maxKg: null }; return next; });
                    }}>✕</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="b2b-btn-secondary" style={{ marginTop: 8, padding: "5px 12px", fontSize: 12 }}
          onClick={() => setBoxCats((cs) => {
            const lastBounded = [...cs].reverse().find((x) => x.maxKg != null)?.maxKg ?? 0;
            const next = cs.map((x) => ({ ...x }));
            next[next.length - 1] = { ...next[next.length - 1], maxKg: lastBounded + 1 };
            return [...next, { name: "새 종류", maxKg: null }];
          })}>+ 종류 추가</button>
        {(() => {
          const errs = validateBoxCats(boxCats, history[history.length - 1]?.boxTiers ?? DEFAULT_RATES.boxTiers);
          return errs.length ? <div className="b2b-error" style={{ marginTop: 10, whiteSpace: "pre-line" }}>{errs.join("\n")}</div> : null;
        })()}
        <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          이름을 바꾸거나 지워도 <strong>과거 배송일지 기록은 사라지지 않습니다</strong> — 예전 이름의 열이 표·엑셀에 그대로 남아 함께 표시됩니다.
          다만 새로 기록할 때는 위 목록만 고를 수 있습니다. 저장은 위 <strong>저장</strong> 버튼을 누르세요.
          <br />무게 기준(이하 kg)을 바꾸면 같은 무게의 박스가 이전과 다른 종류로 집계되니, 기간을 걸친 통계 비교 시 참고하세요.
        </p>
      </div>

      {/* 중복 방지 — 이미 출고 처리된 주문 자동 제외 기준 */}
      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="b2b-card-title">중복 방지 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>· 이미 출고 처리된 주문을 파일에서 자동 제외</span></span>
          <label className="sm-row" style={{ gap: 7, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            <input type="checkbox" className="b2b-checkbox" checked={dedup.enabled} onChange={(e) => setDedup({ ...dedup, enabled: e.target.checked })} /> 사용
          </label>
        </div>
        <div className="sm-col" style={{ gap: 12, opacity: dedup.enabled ? 1 : 0.5, pointerEvents: dedup.enabled ? "auto" : "none" }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 5 }}>같은 주문으로 보는 기준</div>
            <div className="sm-tabs" style={{ margin: 0 }}>
              {([["order_and_items", "주문번호 + 상품 구성"], ["order_only", "주문번호만"]] as [DedupMatch, string][]).map(([v, l]) => (
                <button key={v} className={`sm-tab ${dedup.match === v ? "is-active" : ""}`} onClick={() => setDedup({ ...dedup, match: v })}>{l}</button>
              ))}
            </div>
            <p className="sm-faint" style={{ fontSize: 11.5, margin: "6px 0 0", lineHeight: 1.6 }}>
              {dedup.match === "order_and_items"
                ? "주문번호와 담긴 상품·수량이 모두 같아야 중복으로 봅니다(권장). 번호만 우연히 겹치는 별개 주문은 통과합니다."
                : "주문번호가 같으면 중복으로 봅니다. 번호가 재사용되는 채널에선 정상 주문이 막힐 수 있어 권장하지 않습니다."}
            </p>
          </div>
          <label className="sm-row" style={{ gap: 8, fontSize: 13, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>대조 기간</span>
            최근 <input type="number" className="b2b-input" min={1} max={180} value={dedup.windowDays} onChange={(e) => setDedup({ ...dedup, windowDays: num(e.target.value) })} style={{ width: 70, textAlign: "right" }} /> 일 내 출고 완료분과 대조
          </label>
          <div className="sm-faint" style={{ fontSize: 12 }}>
            현재 등록된 처리완료 주문: <strong>{processedCount == null ? "—" : processedCount.toLocaleString()}</strong>건
            {processedCount != null && processedCount > 0 && <button className="b2b-link-btn" style={{ fontSize: 12, marginLeft: 8, color: "var(--sm-danger)" }} onClick={clearProcessed} disabled={dedupSaving}>기록 비우기</button>}
          </div>
        </div>
        <div className="sm-row" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
          <button className="b2b-btn-primary" style={{ padding: "6px 16px" }} onClick={saveDedup} disabled={dedupSaving}>{dedupSaving ? "저장 중…" : "중복 방지 저장"}</button>
          {dedupMsg && <span style={{ fontSize: 12, color: dedupMsg.includes("실패") ? "var(--sm-danger)" : "var(--sm-success)" }}>{dedupMsg}</span>}
        </div>
      </div>

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
