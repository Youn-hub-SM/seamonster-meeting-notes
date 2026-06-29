"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryRow } from "@/app/lib/inventory";
import TxnModal from "../TxnModal";
import TxnTable from "../TxnTable";

export default function AdjustPage() {
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
        <div><h1 className="b2b-page-title">재고 조정</h1><p className="b2b-page-subtitle">실사·파손·분실 등으로 장부 재고를 보정합니다. 실사 수량(목표) 또는 증감(±)으로 입력.</p></div>
        <div className="b2b-page-actions"><button className="b2b-btn-primary" onClick={() => setOpen(true)}>+ 조정 기록</button></div>
      </header>
      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">조정 내역</span></div>
        <TxnTable type="조정" reloadKey={reload} onChanged={load} />
      </section>
      {open && <TxnModal products={products} qtyOf={qtyOf} defaultType="조정" onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReload((n) => n + 1); load(); }} />}
    </div>
  );
}
