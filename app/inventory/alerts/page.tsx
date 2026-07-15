"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { InventoryRow } from "@/app/lib/inventory";

export default function AlertsPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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

  const low = useMemo(() => rows.filter((r) => r.low).sort((a, b) => (a.qty - a.min_qty) - (b.qty - b.min_qty)), [rows]);
  const withMin = useMemo(() => rows.filter((r) => r.min_qty > 0).length, [rows]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고 부족 알림</h1></div>
      </header>
      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}
      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : low.length === 0 ? (
        <div className="b2b-empty">{withMin === 0 ? "안전재고가 설정된 품목이 없습니다. 제품목록에서 기준을 정하세요." : "부족한 품목이 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>품목</th><th>SKU</th><th className="num">현재고</th><th className="num">안전재고</th><th className="num">부족분</th></tr></thead>
            <tbody>
              {low.map((r) => (
                <tr key={r.product_id} style={{ background: "var(--sm-danger-bg)" }}>
                  <td><strong>{r.name}</strong>{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}</td>
                  <td className="sm-faint">{r.sku || "-"}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>{r.qty.toLocaleString()}{r.unit}</td>
                  <td className="num b2b-money">{r.min_qty.toLocaleString()}{r.unit}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>{Math.max(0, r.min_qty - r.qty).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
