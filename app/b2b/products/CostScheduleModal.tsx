"use client";

import { useEscClose } from "@/app/lib/use-esc";
import { useCallback, useEffect, useMemo, useState } from "react";

// 원가 변경 예약 — "n월 n일부터 이 원가". 인상일에 맞춰 사람이 고치는 걸 놓치지 않게 미리 걸어둔다.
//  반영은 DB 함수(apply_due_cost_schedules)가 매일 00:10 KST 에 한다. 여기서는 걸고·보고·취소한다.

export type CostSchedProduct = {
  id: string; name: string; sku: string | null; cost_price: number;
  cost_material?: number | null; pkg_inner?: number | null; pkg_label?: number | null; pkg_outer?: number | null;
};
type Sched = {
  id: string; effective_date: string; cost_price: number; memo: string | null;
  applied_at: string | null; created_by: string | null;
  cost_material: number; pkg_inner: number; pkg_label: number; pkg_outer: number;
};

const won = (n: number) => Math.round(n).toLocaleString();
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export default function CostScheduleModal({ product, onClose, onApplied }: {
  product: CostSchedProduct; onClose: () => void; onApplied: () => void;
}) {
  useEscClose(onClose);
  const [rows, setRows] = useState<Sched[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pendingMigration, setPendingMigration] = useState(false);

  // 입력 — 현재 원가를 초기값으로 채워 '얼마에서 얼마로' 가 바로 보이게 한다.
  const [date, setDate] = useState("");
  const [mode, setMode] = useState<"detail" | "flat">(
    (Number(product.cost_material) || 0) + (Number(product.pkg_inner) || 0) +
    (Number(product.pkg_label) || 0) + (Number(product.pkg_outer) || 0) > 0 ? "detail" : "flat"
  );
  const [cm, setCm] = useState(String(Number(product.cost_material) || 0));
  const [pi, setPi] = useState(String(Number(product.pkg_inner) || 0));
  const [pl, setPl] = useState(String(Number(product.pkg_label) || 0));
  const [po, setPo] = useState(String(Number(product.pkg_outer) || 0));
  const [flat, setFlat] = useState(String(product.cost_price || 0));
  const [memo, setMemo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await (await fetch(`/api/b2b/products/cost-schedules?product_id=${product.id}`, { cache: "no-store" })).json();
      if (j.ok) { setRows(j.schedules || []); setPendingMigration(!!j.pending_migration); }
      else setError(j.error || "조회 실패");
    } catch { setError("조회 실패"); }
    setLoading(false);
  }, [product.id]);
  useEffect(() => { load(); }, [load]);

  const nextCost = useMemo(() => {
    if (mode === "flat") return Number(flat) || 0;
    return (Number(cm) || 0) + (Number(pi) || 0) + (Number(pl) || 0) + (Number(po) || 0);
  }, [mode, flat, cm, pi, pl, po]);
  const diff = nextCost - (product.cost_price || 0);

  async function save() {
    if (!date) { setError("적용일을 고르세요."); return; }
    if (date < kstToday()) { setError("지난 날짜로는 예약할 수 없습니다."); return; }
    if (nextCost <= 0) { setError("원가를 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const body = mode === "detail"
        ? { product_id: product.id, effective_date: date, cost_material: cm, pkg_inner: pi, pkg_label: pl, pkg_outer: po, memo }
        : { product_id: product.id, effective_date: date, cost_price: flat, memo };
      const j = await (await fetch("/api/b2b/products/cost-schedules", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).json();
      if (!j.ok) throw new Error(j.error || "예약 실패");
      setDate(""); setMemo("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "예약 실패"); }
    setSaving(false);
  }

  async function cancel(id: string) {
    if (!window.confirm("이 예약을 취소할까요?")) return;
    setError("");
    try {
      const j = await (await fetch(`/api/b2b/products/cost-schedules?id=${id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "취소 실패");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "취소 실패"); }
  }

  // 적용일이 이미 됐는데 크론 전이면 여기서 밀어 넣는다
  const dueNow = rows.some((r) => !r.applied_at && r.effective_date <= kstToday());
  async function applyNow() {
    setSaving(true); setError("");
    try {
      const j = await (await fetch("/api/b2b/products/cost-schedules", { method: "PATCH" })).json();
      if (!j.ok) throw new Error(j.error || "반영 실패");
      await load();
      onApplied();
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">
            원가 변경 예약 — {product.name}
            <span className="sm-faint" style={{ marginLeft: 10, fontSize: 13, fontWeight: 400 }}>현재 {won(product.cost_price)}원</span>
          </span>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {pendingMigration ? (
            <div className="sm-warn">예약 기능을 쓰려면 마이그레이션 <code>093_cost_schedules.sql</code> 을 Supabase 에 먼저 적용해야 합니다.</div>
          ) : (
            <>
              <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px", lineHeight: 1.6 }}>
                정한 날짜가 되면 새벽에 자동으로 원가가 바뀝니다. 지난 발주의 이익률은 그대로입니다 —
                발주는 등록 시점 원가를 따로 저장해 두기 때문입니다.
              </p>

              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">적용일</span>
                  <input className="b2b-input" type="date" min={kstToday()} value={date} onChange={(e) => setDate(e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">메모 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택)</span></span>
                  <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 제조사 단가 인상 통보" /></label>
              </div>

              <div className="sm-tabs" style={{ margin: "12px 0 10px" }}>
                <button className={`sm-tab ${mode === "detail" ? "is-active" : ""}`} onClick={() => setMode("detail")}>상세(제품원가+포장재)</button>
                <button className={`sm-tab ${mode === "flat" ? "is-active" : ""}`} onClick={() => setMode("flat")}>원가 직접 입력</button>
              </div>

              {mode === "detail" ? (
                <div className="b2b-field-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                  <label className="b2b-field"><span className="b2b-field-label">제품원가</span>
                    <input className="b2b-input" type="number" min={0} value={cm} onChange={(e) => setCm(e.target.value)} style={{ textAlign: "right" }} /></label>
                  <label className="b2b-field"><span className="b2b-field-label">내포장지</span>
                    <input className="b2b-input" type="number" min={0} value={pi} onChange={(e) => setPi(e.target.value)} style={{ textAlign: "right" }} /></label>
                  <label className="b2b-field"><span className="b2b-field-label">라벨</span>
                    <input className="b2b-input" type="number" min={0} value={pl} onChange={(e) => setPl(e.target.value)} style={{ textAlign: "right" }} /></label>
                  <label className="b2b-field"><span className="b2b-field-label">외포장지</span>
                    <input className="b2b-input" type="number" min={0} value={po} onChange={(e) => setPo(e.target.value)} style={{ textAlign: "right" }} /></label>
                </div>
              ) : (
                <label className="b2b-field" style={{ maxWidth: 220 }}><span className="b2b-field-label">원가</span>
                  <input className="b2b-input" type="number" min={0} value={flat} onChange={(e) => setFlat(e.target.value)} style={{ textAlign: "right" }} /></label>
              )}

              <div className="sm-row" style={{ gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14 }}>
                  {won(product.cost_price)}원 → <strong>{won(nextCost)}원</strong>
                </span>
                {nextCost > 0 && diff !== 0 && (
                  <span className="b2b-status-pill" style={{
                    background: diff > 0 ? "var(--sm-danger-bg)" : "var(--sm-success-bg)",
                    color: diff > 0 ? "var(--sm-danger)" : "var(--sm-success)",
                  }}>
                    {diff > 0 ? "▲" : "▼"} {won(Math.abs(diff))}원
                    {product.cost_price > 0 ? ` (${(Math.abs(diff) / product.cost_price * 100).toFixed(1)}%)` : ""}
                  </span>
                )}
              </div>

              <div style={{ marginTop: 18, borderTop: "1px solid var(--sm-border)", paddingTop: 12 }}>
                <div className="sm-between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>예약 내역</strong>
                  {dueNow && (
                    <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={applyNow} disabled={saving}>
                      지금 반영
                    </button>
                  )}
                </div>
                {loading ? <div className="b2b-loading">불러오는 중...</div>
                  : rows.length === 0 ? <p className="sm-faint" style={{ fontSize: 12 }}>아직 없습니다.</p>
                  : (
                    <div className="b2b-table-wrap" style={{ maxHeight: 200, overflow: "auto" }}>
                      <table className="b2b-table" style={{ fontSize: 13 }}>
                        <thead><tr><th>적용일</th><th className="num">원가</th><th>상태</th><th>메모</th><th /></tr></thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <td style={{ whiteSpace: "nowrap" }}>{r.effective_date}</td>
                              <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(r.cost_price)}</td>
                              <td>
                                {r.applied_at
                                  ? <span className="b2b-status-pill" style={{ background: "var(--sm-success-bg)", color: "var(--sm-success)" }}>반영됨</span>
                                  : <span className="b2b-status-pill" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)" }}>대기</span>}
                              </td>
                              <td className="sm-faint" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.memo || ""}>{r.memo || "-"}</td>
                              <td style={{ textAlign: "right" }}>
                                {!r.applied_at && (
                                  <button type="button" className="b2b-icon-btn is-danger" aria-label="예약 취소" onClick={() => cancel(r.id)}>✕</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </div>
            </>
          )}

          {error && <div className="b2b-error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>닫기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving || pendingMigration}>
              {saving ? "저장 중..." : "예약 추가"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
