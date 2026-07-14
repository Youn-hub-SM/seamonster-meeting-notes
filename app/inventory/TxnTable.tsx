"use client";

import { useCallback, useEffect, useState } from "react";
import { INV_TYPE_COLOR, INV_CHANNEL_COLOR, type InventoryTxn, type InvTxnType, type InvChannel } from "@/app/lib/inventory";

// 재고 원장 테이블 — 활동 히스토리·구매판매·조정 공용. type/types 필터·품목 필터 지원, 행 취소.
export default function TxnTable({ type, types, productId, reloadKey = 0, onChanged }: { type?: InvTxnType; types?: InvTxnType[]; productId?: string; reloadKey?: number; onChanged?: () => void }) {
  const [rows, setRows] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const sp = new URLSearchParams();
      if (type) sp.set("type", type);
      if (productId) sp.set("product_id", productId);
      const j = await (await fetch(`/api/inventory/txns?${sp.toString()}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      const all: InventoryTxn[] = j.rows || [];
      setRows(types && types.length ? all.filter((t) => types.includes(t.type)) : all);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [type, types, productId]);
  useEffect(() => { load(); }, [load, reloadKey]);

  async function cancel(t: InventoryTxn) {
    if (!window.confirm(`이 거래를 취소(삭제)할까요? 재고가 원복됩니다.`)) return;
    await fetch(`/api/inventory/txn?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    await load();
    onChanged?.();
  }

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;
  if (error) return <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>;
  if (rows.length === 0) return <div className="b2b-empty">내역이 없습니다.</div>;

  return (
    <div className="b2b-table-wrap">
      <table className="b2b-table">
        <thead><tr><th>거래일</th><th>품목</th><th>유형</th><th>채널</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th><th>메모</th><th>담당</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => {
            const c = INV_TYPE_COLOR[t.type];
            const ch = t.channel ? INV_CHANNEL_COLOR[t.channel as InvChannel] : null;
            return (
              <tr key={t.id}>
                <td style={{ whiteSpace: "nowrap" }}>{t.txn_date?.slice(5)}</td>
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.product_name}{t.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{t.sku}</span> : null}</td>
                <td><span className="b2b-feed-pill" style={{ background: c.bg, color: c.fg, fontWeight: 700 }}>{t.type}</span></td>
                <td>{ch ? <span className="b2b-feed-pill" style={{ background: ch.bg, color: ch.fg, fontWeight: 700 }}>{t.channel}</span> : <span className="sm-faint">-</span>}</td>
                <td className="num b2b-money" style={{ color: t.qty >= 0 ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 700 }}>{t.qty > 0 ? "+" : ""}{t.qty.toLocaleString()}</td>
                <td className="num b2b-money">{t.unit_amount ? t.unit_amount.toLocaleString() : "-"}</td>
                <td>{t.partner || "-"}</td>
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.memo || ""}>{t.memo || "-"}</td>
                <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{t.created_by || "-"}</td>
                <td><button className="b2b-link-btn" onClick={() => cancel(t)} style={{ color: "var(--sm-danger)" }}>취소</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
