"use client";

import { useCallback, useEffect, useState } from "react";
import { INV_TYPE_COLOR } from "@/app/lib/inventory";

type OrderItem = { id: string; product_name: string; sku: string | null; qty: number; unit_amount: number | null; amount: number };
type Order = {
  key: string; order_no: string | null; type: "입고" | "출고"; status: "대기" | "완료"; txn_date: string; created_at: string;
  partner: string | null; memo: string | null; created_by: string | null;
  item_count: number; total_qty: number; total_amount: number; items: OrderItem[];
};

// 입출고 '주문(묶음)' 목록 — BoxHero 구매목록 스타일. 한 번에 입력한 라인이 하나의 주문번호로 묶임.
export default function OrdersTable({ reloadKey = 0 }: { reloadKey?: number }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/inventory/orders", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setOrders(j.orders || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  function toggle(k: string) { setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }
  async function cancel(o: Order) {
    if (!window.confirm(`${o.order_no || "이 건"} (${o.item_count}개 품목)을 취소할까요? 재고가 원복됩니다.`)) return;
    const qs = o.order_no ? `group_id=${encodeURIComponent(o.key)}` : `id=${encodeURIComponent(o.key)}`;
    await fetch(`/api/inventory/orders?${qs}`, { method: "DELETE" });
    await load();
  }
  async function process(o: Order) {
    const key = o.order_no ? { group_id: o.key } : { id: o.key };
    await fetch(`/api/inventory/orders`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...key, status: "완료" }) });
    await load();
  }
  // created_at(UTC timestamptz)을 한국(KST) 시각으로 표시. sv-SE 로케일 = "YYYY-MM-DD HH:mm:ss".
  const dt = (iso: string) => {
    if (!iso) return "-";
    try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
    catch { return iso.slice(0, 16).replace("T", " "); }
  };

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;
  if (error) return <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>;
  if (orders.length === 0) return <div className="b2b-empty">입고·출고 내역이 없습니다.</div>;

  return (
    <div className="b2b-table-wrap">
      <table className="b2b-table">
        <thead><tr><th>상태</th><th>일시</th><th>주문번호</th><th>거래처</th><th>품목 수</th><th className="num">총수량</th><th className="num">총액</th><th>메모</th><th></th></tr></thead>
        <tbody>
          {orders.map((o) => {
            const c = INV_TYPE_COLOR[o.type];
            const isOpen = open.has(o.key);
            const done = o.status === "완료";
            const badge = done ? c : { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" };
            return (
              <FragmentRows key={o.key}>
                <tr onClick={() => toggle(o.key)} style={{ cursor: "pointer" }}>
                  <td><span className="b2b-feed-pill" style={{ background: badge.bg, color: badge.fg, fontWeight: 700, whiteSpace: "nowrap" }}>{o.type} {o.status}</span></td>
                  <td style={{ whiteSpace: "nowrap" }}>{dt(o.created_at)}</td>
                  <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>{o.order_no || <span className="sm-faint">단건</span>}</td>
                  <td>{o.partner || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{o.item_count}개 품목 <span style={{ color: "var(--sm-text-light)", fontSize: 11 }}>{isOpen ? "▲" : "▼"}</span></td>
                  <td className="num b2b-money">{o.total_qty.toLocaleString()}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}>₩{o.total_amount.toLocaleString()}</td>
                  <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.memo || ""}>{o.memo || "-"}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    {!done && <button className="b2b-btn-secondary" style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }} onClick={() => process(o)}>{o.type === "입고" ? "입고처리" : "출고처리"}</button>}
                    <button className="b2b-link-btn" onClick={() => cancel(o)} style={{ color: "var(--sm-danger)" }}>취소</button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={9} style={{ background: "var(--sm-bg-subtle)", padding: "10px 16px" }}>
                      <table className="b2b-table" style={{ background: "var(--sm-white)" }}>
                        <thead><tr><th>제품</th><th className="num">수량</th><th className="num">단가</th><th className="num">금액</th></tr></thead>
                        <tbody>
                          {o.items.map((it) => (
                            <tr key={it.id}>
                              <td>{it.product_name}{it.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{it.sku}</span> : null}</td>
                              <td className="num b2b-money">{it.qty.toLocaleString()}</td>
                              <td className="num b2b-money">{it.unit_amount ? it.unit_amount.toLocaleString() : "-"}</td>
                              <td className="num b2b-money">₩{it.amount.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }
