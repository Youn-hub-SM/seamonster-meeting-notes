"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INV_TYPE_COLOR, type InventoryTxn } from "@/app/lib/inventory";

// 활동 히스토리 — 날짜별 아코디언. 품목·SKU·메모 검색 시 해당 날짜만 펼쳐 보임.
export default function ActivityPage() {
  const [txns, setTxns] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/inventory/txns?limit=2000", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      const rows: InventoryTxn[] = j.rows || [];
      setTxns(rows);
      setOpen(new Set(rows.length ? [rows[0].txn_date] : [])); // 가장 최근 날짜만 펼침
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function cancel(t: InventoryTxn) {
    if (!window.confirm("이 거래를 취소(삭제)할까요? 재고가 원복됩니다.")) return;
    await fetch(`/api/inventory/txn?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    await load();
  }

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => q
    ? txns.filter((t) => `${t.product_name} ${t.sku || ""} ${t.memo || ""} ${t.partner || ""}`.toLowerCase().includes(q))
    : txns, [txns, q]);

  // 날짜별 묶음(최신순)
  const groups = useMemo(() => {
    const m = new Map<string, InventoryTxn[]>();
    for (const t of filtered) { const d = t.txn_date || "(미지정)"; const a = m.get(d); if (a) a.push(t); else m.set(d, [t]); }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const isOpen = (d: string) => (q ? true : open.has(d)); // 검색 중이면 매칭 날짜 자동 펼침
  const toggle = (d: string) => setOpen((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">활동 히스토리</h1><p className="b2b-page-subtitle">모든 입고·출고·조정 원장을 날짜별로 묶었습니다. 품목·SKU·메모로 검색하면 해당 날짜만 펼쳐 볼 수 있어요.</p></div>
        <div className="b2b-page-actions"><button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button></div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <input className="b2b-input" placeholder="품목·SKU·메모·거래처 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280, maxWidth: "100%" }} />
        {q && <span className="sm-faint" style={{ fontSize: 12 }}>{groups.length}일 · {filtered.length}건</span>}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : groups.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📭</div>{txns.length === 0 ? "내역이 없습니다." : "검색 결과가 없습니다."}</div>
      ) : (
        <div className="sm-col" style={{ gap: 8 }}>
          {groups.map(([date, list]) => {
            const o = isOpen(date);
            const byType = list.reduce((m, t) => { m[t.type] = (m[t.type] || 0) + 1; return m; }, {} as Record<string, number>);
            return (
              <section key={date} className="b2b-card" style={{ padding: 0, overflow: "hidden" }}>
                <button onClick={() => toggle(date)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ color: "var(--sm-text-light)", fontSize: 12, transform: o ? "rotate(90deg)" : "none", transition: "transform .12s" }}>▶</span>
                  <strong style={{ fontSize: 14 }}>{date}</strong>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{list.length}건</span>
                  <span className="sm-row" style={{ gap: 4, marginLeft: "auto", flexWrap: "wrap" }}>
                    {Object.entries(byType).map(([ty, n]) => { const c = INV_TYPE_COLOR[ty as keyof typeof INV_TYPE_COLOR]; return <span key={ty} className="b2b-feed-pill" style={{ background: c.bg, color: c.fg, fontSize: 11, fontWeight: 700 }}>{ty} {n}</span>; })}
                  </span>
                </button>
                {o && (
                  <div className="b2b-table-wrap" style={{ borderTop: "1px solid var(--sm-border)" }}>
                    <table className="b2b-table">
                      <thead><tr><th>품목</th><th>유형</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th><th>메모</th><th>담당</th><th></th></tr></thead>
                      <tbody>
                        {list.map((t) => {
                          const c = INV_TYPE_COLOR[t.type];
                          return (
                            <tr key={t.id}>
                              <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.product_name}{t.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{t.sku}</span> : null}</td>
                              <td><span className="b2b-feed-pill" style={{ background: c.bg, color: c.fg, fontWeight: 700 }}>{t.type}</span></td>
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
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
