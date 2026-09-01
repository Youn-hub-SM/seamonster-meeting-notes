"use client";

import { useCallback, useEffect, useState } from "react";
import { INV_TYPE_COLOR, INV_CHANNEL_COLOR, type InventoryTxn, type InvTxnType, type InvChannel } from "@/app/lib/inventory";

// 재고 원장 테이블 — 활동 히스토리·구매판매·조정 공용. type/types 필터·품목 필터 지원, 행 취소.
export default function TxnTable({ type, types, productId, reloadKey = 0, onChanged }: { type?: InvTxnType; types?: InvTxnType[]; productId?: string; reloadKey?: number; onChanged?: () => void }) {
  const [rows, setRows] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 단가 인라인 수정 — 단가만 고칠 수 있다(수량·품목·날짜는 재고에 영향 → 취소 후 재기록)
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);

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
    const r = await fetch(`/api/inventory/txn?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) { alert(`취소 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    await load();
    onChanged?.();
  }

  async function saveUnit(t: InventoryTxn) {
    if (saving) return;
    setSaving(true);
    const r = await fetch("/api/inventory/txn", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, unit_amount: editVal.trim() === "" ? null : Number(editVal) }),
    });
    const j = await r.json().catch(() => null);
    setSaving(false);
    if (!r.ok || !j?.ok) { alert(`단가 수정 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    setEditId(null);
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
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.product_name}{t.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{t.sku}</span> : null}</td>
                <td><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span></td>
                <td>{ch ? <span className="b2b-status-pill" style={{ background: ch.bg, color: ch.fg }}>{t.channel}</span> : <span className="sm-faint">-</span>}</td>
                <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{t.qty > 0 ? "+" : ""}{t.qty.toLocaleString()}</td>
                <td className="num b2b-money" style={{ whiteSpace: "nowrap" }}>
                  {editId === t.id ? (
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <input
                        autoFocus type="number" min={0} className="b2b-input" value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveUnit(t); if (e.key === "Escape") setEditId(null); }}
                        style={{ width: 90, padding: "3px 8px", fontSize: 13, textAlign: "right" }}
                      />
                      <button className="b2b-link-btn" onClick={() => saveUnit(t)} disabled={saving}>저장</button>
                      <button className="b2b-link-btn sm-faint" onClick={() => setEditId(null)}>취소</button>
                    </span>
                  ) : (
                    <>
                      {t.unit_amount ? t.unit_amount.toLocaleString() : "-"}
                      {t.type !== "조정" && (
                        <button className="b2b-link-btn sm-faint" style={{ marginLeft: 6, fontSize: 12 }} title="단가만 수정합니다 — 수량·날짜는 취소 후 다시 기록"
                          onClick={() => { setEditId(t.id); setEditVal(t.unit_amount ? String(t.unit_amount) : ""); }}>수정</button>
                      )}
                    </>
                  )}
                </td>
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
