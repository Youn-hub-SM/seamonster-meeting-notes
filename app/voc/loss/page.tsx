"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_FAULTS, VOC_FAULT_CLAIMABLE, VOC_FAULT_BURDEN, VOC_COMP_MANUAL, computeVocLoss, type Voc } from "@/app/lib/voc";
import { Donut, TrendChart, PieCard, BarList, moneyCompact } from "@/app/components/charts";

type RMode = "7일" | "14일" | "30일" | "custom";
type Unit = "주별" | "월별";
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function presetStart(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 - (days - 1) * 86400_000).toISOString().slice(0, 10);
}
function weekStart(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}
function periodKey(dateStr: string, unit: Unit): string {
  if (!dateStr) return "미지정";
  return unit === "주별" ? weekStart(dateStr) : dateStr.slice(0, 7);
}
function periodLabel(key: string, unit: Unit): string {
  if (unit === "월별") return key;
  const s = new Date(key + "T00:00:00");
  const e = new Date(s.getTime() + 6 * 86400_000);
  const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${f(s)}~${f(e)}`;
}

// 귀책 색(정산) — 제조사=청구가능(초록), 물류=주의, 자사=부담(빨강), 고객=정보, 미분류=회색
const FAULT_META: { key: string; color: string }[] = [
  { key: "제조사", color: "var(--sm-success)" },
  { key: "물류", color: "var(--sm-warning)" },
  { key: "자사", color: "var(--sm-danger)" },
  { key: "고객", color: "var(--sm-info)" },
  { key: "미분류", color: "var(--sm-text-light)" },
];
const FAULT_COLOR: Record<string, string> = Object.fromEntries(FAULT_META.map((f) => [f.key, f.color]));

type Prod = { name: string; cost_price: number | null; volume_kg: number | null };
const won = (n: number) => n.toLocaleString();

export default function VocLossPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [products, setProducts] = useState<Prod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RMode>("30일");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [unit, setUnit] = useState<Unit>("주별");
  const [busy, setBusy] = useState(false);
  const nowMonth = new Date(Date.now() + 9 * 3600_000).getMonth() + 1;

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [vj, pj] = await Promise.all([
        (await fetch("/api/voc", { cache: "no-store" })).json(),
        (await fetch("/api/products", { cache: "no-store" })).json(),
      ]);
      if (!vj.ok) throw new Error(vj.error || "조회 실패");
      setRows(vj.rows || []);
      if (pj.ok) setProducts(pj.products || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const period = useMemo(() => {
    if (mode === "custom") return { from: fromDate || "0000-00-00", to: toDate || TODAY(), label: `${fromDate || "처음"} ~ ${toDate || TODAY()}` };
    const days = mode === "7일" ? 7 : mode === "14일" ? 14 : 30;
    return { from: presetStart(days), to: TODAY(), label: `최근 ${mode}` };
  }, [mode, fromDate, toDate]);
  const shown = useMemo(() => rows.filter((r) => { const d = r.received_at || ""; return d >= period.from && d <= period.to; }), [rows, period]);

  // 현재 상품 마스터(원가·부피) 기준 재계산값 — 자동유형만, 매칭 안 되면 기존값 유지
  const recompute = useCallback((r: Voc): number => {
    if (r.comp_type === "없음" || VOC_COMP_MANUAL.has(r.comp_type)) return r.loss_amount || 0;
    const p = products.find((x) => x.name === r.product);
    if (!p) return r.loss_amount || 0;
    return computeVocLoss({ compType: r.comp_type, qty: r.comp_qty, costPrice: Number(p.cost_price) || 0, volumeKg: Number(p.volume_kg) || 0, receivedAt: r.received_at, fallbackMonth: nowMonth }).amount;
  }, [products, nowMonth]);
  const stale = useMemo(() => shown.filter((r) => recompute(r) !== (r.loss_amount || 0)), [shown, recompute]);

  // 집계
  const totalLoss = useMemo(() => shown.reduce((s, r) => s + (r.loss_amount || 0), 0), [shown]);
  const byFault = useMemo(() => FAULT_META.map((f) => ({ ...f, loss: shown.filter((r) => (r.fault || "미분류") === f.key).reduce((s, r) => s + (r.loss_amount || 0), 0) })), [shown]);
  const claimable = useMemo(() => shown.filter((r) => VOC_FAULT_CLAIMABLE.has(r.fault || "")).reduce((s, r) => s + (r.loss_amount || 0), 0), [shown]);
  const burden = useMemo(() => shown.filter((r) => VOC_FAULT_BURDEN.has(r.fault || "")).reduce((s, r) => s + (r.loss_amount || 0), 0), [shown]);
  const other = totalLoss - claimable - burden;

  const lossBy = useCallback((key: (r: Voc) => string): [string, number][] => {
    const m = new Map<string, number>();
    for (const r of shown) if (r.loss_amount) { const k = key(r) || "미지정"; m.set(k, (m.get(k) || 0) + r.loss_amount); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [shown]);
  const lossByFault = useMemo<[string, number][]>(() => byFault.filter((f) => f.loss > 0).map((f) => [f.key, f.loss]), [byFault]);
  const lossByCat = useMemo(() => lossBy((r) => r.category), [lossBy]);
  const lossByComp = useMemo(() => lossBy((r) => r.comp_type), [lossBy]);
  const lossByProduct = useMemo(() => lossBy((r) => r.product || "미지정").slice(0, 8), [lossBy]);

  const trend = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shown) { const k = periodKey(r.received_at || "", unit); m.set(k, (m.get(k) || 0) + (r.loss_amount || 0)); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ label: periodLabel(k, unit), value: v }));
  }, [shown, unit]);

  async function changeFault(r: Voc, fault: string) {
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, fault: fault as Voc["fault"] } : x)));
    try {
      const res = await fetch("/api/voc", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, fault }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "변경 실패");
    } catch (e) { setError(e instanceof Error ? e.message : "귀책 변경 실패"); await load(); }
  }
  async function recalcAll() {
    if (!stale.length || busy) return;
    if (!window.confirm(`${stale.length}건의 손해금액을 현재 상품 원가·배송비 기준으로 갱신할까요?`)) return;
    setBusy(true); setError("");
    try {
      for (const r of stale) {
        await fetch("/api/voc", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, loss_amount: recompute(r) }) });
      }
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "갱신 실패"); }
    setBusy(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">손해금액 산정</h1>
          <p className="b2b-page-subtitle">VOC 손해를 <strong>귀책별</strong>로 정산합니다 — 제조사 청구 가능액과 자사 부담액을 분리하고, 현재 원가 기준으로 재계산. 제조사 제출은 <Link href="/voc/reports" className="change-link">개선요청서</Link>.</p>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href={`/api/voc/loss/export?from=${period.from}&to=${period.to}`}>엑셀 추출</a>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("fault") || error.includes("column")) ? " — supabase/migrations/030_voc_fault.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="sm-tabbar">
        {(["7일", "14일", "30일"] as RMode[]).map((m) => (
          <button key={m} className={`sm-tab ${mode === m ? "is-active" : ""}`} onClick={() => setMode(m)}>{`최근 ${m}`}</button>
        ))}
        <button className={`sm-tab ${mode === "custom" ? "is-active" : ""}`} onClick={() => setMode("custom")}>직접지정</button>
        {mode === "custom" && (
          <span className="sm-row" style={{ gap: 6 }}>
            <input className="b2b-input" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} style={{ width: "auto" }} />
            <span className="sm-faint">~</span>
            <input className="b2b-input" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} style={{ width: "auto" }} />
          </span>
        )}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="b2b-empty">집계할 VOC가 없습니다. <Link href="/voc" className="change-link">처리 상태</Link>에서 먼저 등록하세요.</div>
      ) : (
        <>
          <section className="b2b-card sm-stat-hero" style={{ marginBottom: 16 }}>
            <div className="sm-stat-hero-chart">
              <Donut data={lossByFault} colors={lossByFault.map(([k]) => FAULT_COLOR[k])} center={moneyCompact(totalLoss)} centerSub="총 손해" />
            </div>
            <div className="sm-stat-hero-body">
              <div className="sm-stat-hero-label">기간 총 손해/보상 · {period.label}</div>
              <div className="sm-stat-hero-total b2b-money">{won(totalLoss)}원</div>
              <div className="sm-stat-hero-breakdown">
                <div className="sm-stat-hero-metric">
                  <span className="sm-stat-hero-metric-label"><span className="sm-stat-hero-dot" style={{ background: "var(--sm-success)" }} />제조사 청구가능</span>
                  <span className="sm-stat-hero-metric-value" style={{ color: "var(--sm-success)" }}>{won(claimable)}원</span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{totalLoss ? Math.round((claimable / totalLoss) * 100) : 0}%</span>
                </div>
                <div className="sm-stat-hero-metric">
                  <span className="sm-stat-hero-metric-label"><span className="sm-stat-hero-dot" style={{ background: "var(--sm-danger)" }} />물류·자사 부담</span>
                  <span className="sm-stat-hero-metric-value" style={{ color: "var(--sm-danger)" }}>{won(burden)}원</span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{totalLoss ? Math.round((burden / totalLoss) * 100) : 0}%</span>
                </div>
                <div className="sm-stat-hero-metric">
                  <span className="sm-stat-hero-metric-label"><span className="sm-stat-hero-dot" style={{ background: FAULT_COLOR["미분류"] }} />고객·미분류</span>
                  <span className="sm-stat-hero-metric-value" style={{ color: "var(--sm-text-mid)" }}>{won(other)}원</span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{totalLoss ? Math.round((other / totalLoss) * 100) : 0}%</span>
                </div>
              </div>
            </div>
          </section>

          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="b2b-card-title">손해 추세</span>
              <div className="sm-tabs">{(["주별", "월별"] as Unit[]).map((u) => <button key={u} className={`sm-tab ${unit === u ? "is-active" : ""}`} onClick={() => setUnit(u)}>{u}</button>)}</div>
            </div>
            <div className="sm-between" style={{ marginBottom: 6 }}>
              <span className="sm-faint" style={{ fontSize: 11 }}>단위 : 원</span>
              <span className="sm-chart-legend"><span><i style={{ background: "var(--sm-orange)" }} />손해금액</span></span>
            </div>
            <TrendChart data={trend.map((t) => ({ label: t.label, value: t.value, tip: `${t.label} · ${won(t.value)}원` }))} fmtAxis={moneyCompact} />
          </section>

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginBottom: 16 }}>
            <PieCard title="귀책별 손해(원)" data={lossByFault} fmt={won} />
            <PieCard title="클레임 유형별 손해(원)" data={lossByCat} fmt={won} />
            <PieCard title="보상유형별 손해(원)" data={lossByComp} fmt={won} />
            <BarList title="제품별 손해 TOP(원)" data={lossByProduct} accent="var(--sm-danger)" fmt={won} />
          </div>

          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="b2b-card-title">건별 정산 ({shown.length}건)</span>
              {stale.length > 0 && (
                <button className="b2b-btn-secondary" onClick={recalcAll} disabled={busy} style={{ fontSize: 12, padding: "6px 12px" }}>
                  {busy ? "갱신 중…" : `현재 원가로 ${stale.length}건 갱신`}
                </button>
              )}
            </div>
            <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 8px" }}>‘현재기준’은 지금 상품 마스터 원가·배송비로 다시 계산한 값입니다. 다르면 표시 — 위 버튼으로 일괄 반영.</p>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>접수일</th><th>제품</th><th>유형</th><th>보상유형</th><th>귀책</th><th className="num">기록 손해</th><th className="num">현재기준</th></tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const rc = recompute(r);
                    const diff = rc !== (r.loss_amount || 0);
                    return (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                        <td style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product || "-"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.category}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.comp_type}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <select value={r.fault || "미분류"} onChange={(e) => changeFault(r, e.target.value)} className="b2b-input"
                            style={{ padding: "3px 6px", fontSize: 12, width: "auto", border: "none", borderRadius: 7, fontWeight: 700, background: "var(--sm-bg-subtle)", color: FAULT_COLOR[r.fault || "미분류"] }}>
                            {VOC_FAULTS.map((f) => <option key={f} value={f}>{f}</option>)}
                          </select>
                        </td>
                        <td className="num b2b-money">{r.loss_amount ? won(r.loss_amount) : "-"}</td>
                        <td className="num b2b-money" style={{ color: diff ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{diff ? `${won(rc)}` : "="}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
