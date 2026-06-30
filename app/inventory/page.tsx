"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow } from "@/app/lib/inventory";
import TxnModal from "./TxnModal";

export default function InventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [modalFor, setModalFor] = useState<string>(""); // product_id
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/inventory", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);

  const totals = useMemo(() => ({
    items: rows.length,
    value: rows.reduce((s, r) => s + r.value, 0),
    low: rows.filter((r) => r.low).length,
  }), [rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const f = rows.filter((r) => {
      if (onlyLow && !r.low) return false;
      if (q && !(`${r.name} ${r.sku || ""} ${r.location || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
    // 부족만 보기일 땐 부족분(안전−현재) 큰 순으로 — 옛 '재고 부족 알림'과 동일
    return onlyLow ? f.sort((a, b) => (b.min_qty - b.qty) - (a.min_qty - a.qty)) : f;
  }, [rows, search, onlyLow]);

  async function saveMin(r: InventoryRow, v: string) {
    const min_qty = Math.max(0, Math.round(Number(v) || 0));
    if (min_qty === r.min_qty) return;
    setRows((rs) => rs.map((x) => (x.product_id === r.product_id ? { ...x, min_qty, low: min_qty > 0 && x.qty <= min_qty } : x)));
    await fetch("/api/inventory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: r.product_id, min_qty }) });
  }

  async function importBoxhero() {
    if (importing) return;
    if (!window.confirm("박스히어로 현재고를 SKU 기준으로 가져와 기초재고를 맞출까요? (현재고가 박스히어로 수량이 되도록 '조정' 기록)")) return;
    setImporting(true); setError(""); setNote("");
    try {
      const res = await fetch("/api/inventory/import", { method: "POST" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "가져오기 실패");
      setNote(`박스히어로 ${j.boxheroItems}개 중 SKU 일치 ${j.matched}개 · 조정 ${j.applied}건 반영 (미일치 ${j.unmatched})`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "가져오기 실패"); }
    setImporting(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 목록</h1>
          <p className="b2b-page-subtitle">상품 마스터 기준 현재고·재고자산·안전재고. <strong>부족만 보기</strong>로 재고 부족 품목을 모아 봅니다. 행의 <strong>입·출·조정</strong>으로 입출고를 기록합니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={importBoxhero} disabled={importing}>{importing ? "가져오는 중…" : "박스히어로 기초재고 가져오기"}</button>
          <button className="b2b-btn-primary" onClick={() => setModalFor("__new__")}>+ 입·출·조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}
      {note && <div className="b2b-card" style={{ marginBottom: 12, color: "var(--sm-success)", fontSize: 13 }}>✅ {note}</div>}

      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 자산(원가)</div><div className="b2b-stat-card-value b2b-money">{totals.value.toLocaleString()}원</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 부족</div><div className="b2b-stat-card-value" style={{ color: totals.low ? "var(--sm-danger)" : "var(--sm-black)" }}>{totals.low}건</div></div>
      </div>

      <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> 부족만 보기
        </label>
        <input className="b2b-input" placeholder="품목·SKU·위치 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240, maxWidth: "100%" }} />
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📦</div>{rows.length === 0 ? "활성 품목이 없습니다. 상품 마스터에 제품을 등록하세요." : "조건에 맞는 품목이 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>품목</th><th>SKU</th><th>위치</th><th className="num">현재고</th><th className="num">안전재고</th><th className="num">재고자산</th><th></th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.product_id} style={{ background: r.low ? "var(--sm-danger-bg)" : undefined }}>
                  <td><strong>{r.name}</strong>{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}</td>
                  <td className="sm-faint">{r.sku || "-"}</td>
                  <td className="sm-faint">{r.location || "-"}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700, color: r.low ? "var(--sm-danger)" : "var(--sm-black)" }}>{r.qty.toLocaleString()}<span className="sm-faint" style={{ fontWeight: 400, marginLeft: 2 }}>{r.unit}</span>{r.low && <span style={{ display: "block", fontSize: 10.5, fontWeight: 700, color: "var(--sm-danger)" }}>부족 {Math.max(0, r.min_qty - r.qty).toLocaleString()}</span>}</td>
                  <td className="num">
                    <input type="number" min={0} defaultValue={r.min_qty} onBlur={(e) => saveMin(r, e.target.value)}
                      className="b2b-input" style={{ width: 70, padding: "3px 6px", fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td className="num b2b-money">{r.value.toLocaleString()}</td>
                  <td><button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setModalFor(r.product_id)}>입·출·조정</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalFor && (
        <TxnModal
          products={products}
          qtyOf={qtyOf}
          defaultProductId={modalFor === "__new__" ? "" : modalFor}
          lockProduct={modalFor !== "__new__"}
          onClose={() => setModalFor("")}
          onSaved={() => { setModalFor(""); load(); }}
        />
      )}
    </div>
  );
}
