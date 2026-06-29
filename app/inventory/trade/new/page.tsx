"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { InventoryRow } from "@/app/lib/inventory";
import PurchaseForm, { type PickProduct } from "../../PurchaseForm";

export default function NewTradePage() {
  const router = useRouter();
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

  const products = useMemo<PickProduct[]>(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, spec: r.spec, unit: r.unit, cost_price: r.cost_price, purchase_price: r.purchase_price, origin: r.origin, attrs: r.attrs, qty: r.qty })), [rows]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">구매 / 판매 작성</h1>
          <p className="b2b-page-subtitle">여러 제품을 담아 입고·출고를 한 번에 기록합니다. <Link href="/inventory/trade" className="change-link">목록으로</Link></p>
        </div>
      </header>
      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}
      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <PurchaseForm products={products} onSaved={() => router.push("/inventory/trade")} onCancel={() => router.push("/inventory/trade")} />
      )}
    </div>
  );
}
