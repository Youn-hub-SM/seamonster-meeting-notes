"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow } from "@/app/lib/inventory";
import TxnModal from "../TxnModal";
import TxnTable from "../TxnTable";

export default function TradePage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const load = useCallback(async () => {
    const j = await (await fetch("/api/inventory", { cache: "no-store" })).json();
    if (j.ok) setRows(j.rows || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);
  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">구매 및 판매</h1><p className="b2b-page-subtitle">입고(매입)·출고(판매·소진)를 기록합니다.</p></div>
        <div className="b2b-page-actions"><button className="b2b-btn-primary" onClick={() => setOpen(true)}>+ 입고/판매 기록</button></div>
      </header>
      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">입고·출고 내역</span></div>
        <TxnTable types={["입고", "출고"]} reloadKey={reload} onChanged={load} />
      </section>
      {open && <TxnModal products={products} qtyOf={qtyOf} defaultType="입고" onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReload((n) => n + 1); load(); }} />}
    </div>
  );
}
