"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Item = { name: string; prodName: string; sku: string | null; spec: string; qty: number };
type Unit = { id: string; kind: "order" | "manual"; status: string; company: string; orderNo: string | null; date: string | null; items: Item[] };
type Contributor = { company: string; qty: number; unitId: string; kind: "order" | "manual"; status: string };
type ProdCard = { key: string; product: string; spec: string; date: string | null; totalQty: number; status: string; contributors: Contributor[] };

const COLUMNS = ["생산대기", "생산중", "생산완료"] as const;
const COL_COLOR: Record<string, string> = { "생산대기": "#6b7280", "생산중": "#b86e00", "생산완료": "#22863a" };

function rollup(statuses: string[]): string {
  if (statuses.length === 0) return "생산대기";
  if (statuses.every((s) => s === "생산완료")) return "생산완료";
  if (statuses.every((s) => s === "생산대기")) return "생산대기";
  return "생산중";
}

export default function ProductionBoardPage() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [today, setToday] = useState("");
  const [view, setView] = useState<"product" | "company">("product");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await (await fetch("/api/production/board", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setUnits(j.cards || []);
      setToday(j.today || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // 품목별 카드 (품목+규격+생산일)
  const productCards = useMemo(() => {
    const m = new Map<string, ProdCard>();
    for (const u of units) {
      for (const it of u.items) {
        // 같은 SKU = 같은 생산품목으로 묶음 (B2B 품목명 달라도). SKU 없으면 품목명+규격.
        const groupId = it.sku || `${it.name}|${it.spec}`;
        const key = `${groupId}|${u.date || ""}`;
        let c = m.get(key);
        if (!c) { c = { key, product: it.prodName || it.name, spec: it.spec, date: u.date, totalQty: 0, status: "", contributors: [] }; m.set(key, c); }
        c.totalQty += it.qty;
        c.contributors.push({ company: u.company, qty: it.qty, unitId: u.id, kind: u.kind, status: u.status });
      }
    }
    const cards = [...m.values()];
    for (const c of cards) c.status = rollup(c.contributors.map((x) => x.status));
    return cards;
  }, [units]);

  async function moveUnits(refs: { id: string; kind: "order" | "manual" }[], status: string) {
    const seen = new Set<string>();
    const uniq = refs.filter((r) => { const k = r.kind + r.id; if (seen.has(k)) return false; seen.add(k); return true; });
    const prev = units;
    setUnits((us) => us.map((u) => (uniq.some((r) => r.id === u.id && r.kind === u.kind) ? { ...u, status } : u)));
    try {
      await Promise.all(uniq.map(async (r) => {
        const url = r.kind === "order" ? `/api/b2b/orders/${r.id}` : `/api/production/manual`;
        const body = r.kind === "order" ? { production_status: status } : { id: r.id, status };
        const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || "변경 실패");
      }));
    } catch (e) {
      setUnits(prev);
      setError(e instanceof Error ? e.message : "변경 실패");
    }
  }

  const overdueCount = useMemo(() => {
    if (view === "product") return productCards.filter((c) => c.status !== "생산완료" && c.date && c.date < today).length;
    return units.filter((u) => u.status !== "생산완료" && u.date && u.date < today).length;
  }, [productCards, units, view, today]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 보드</h1>
          <p className="b2b-page-subtitle">같은 품목·생산일은 한 카드로 묶어 생산 전·중·완료를 체크합니다. 생산일이 지난 미완료는 재고 쇼트 위험.</p>
        </div>
        <div className="b2b-page-actions">
          <div className="prod-range-tabs">
            <button className={`prod-range-tab ${view === "product" ? "is-active" : ""}`} onClick={() => setView("product")}>품목별</button>
            <button className={`prod-range-tab ${view === "company" ? "is-active" : ""}`} onClick={() => setView("company")}>발주처별</button>
          </div>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {overdueCount > 0 && (
        <div className="b2b-error" style={{ background: "#fff4e0", color: "#b86e00", border: "1px solid #f0d9a8" }}>
          ⚠ 생산일이 지났는데 아직 생산 전/중인 건 {overdueCount}건 — 재고 쇼트 위험
        </div>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const ci = COLUMNS.indexOf(col);
            const productItems = productCards.filter((c) => c.status === col).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
            const companyItems = units.filter((u) => u.status === col).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
            const count = view === "product" ? productItems.length : companyItems.length;
            return (
              <div key={col} className="kanban-col">
                <div className="kanban-col-head" style={{ color: COL_COLOR[col] }}>
                  {col} <span className="kanban-col-count">{count}</span>
                </div>
                <div className="kanban-col-body">
                  {count === 0 ? (
                    <div className="kanban-empty">없음</div>
                  ) : view === "product" ? (
                    productItems.map((c) => {
                      const overdue = c.status !== "생산완료" && !!c.date && c.date < today;
                      return (
                        <div key={c.key} className={`kanban-card ${overdue ? "is-overdue" : ""}`}>
                          <div className="kanban-card-top">
                            <span className="kanban-card-company">{c.product}{c.spec ? <span className="ki-spec"> {c.spec}</span> : ""}</span>
                            {c.date && <span className={`kanban-card-date ${overdue ? "is-overdue" : ""}`}>{c.date.slice(5)}</span>}
                          </div>
                          <div className="kanban-card-bigqty">{c.totalQty.toLocaleString()}<span>개</span></div>
                          <div className="kanban-card-contributors">
                            {c.contributors.map((x, i) => (
                              <span key={i}>{x.company} {x.qty.toLocaleString()}{x.kind === "manual" ? "(직접)" : ""}{i < c.contributors.length - 1 ? " · " : ""}</span>
                            ))}
                          </div>
                          <div className="kanban-card-actions">
                            {ci > 0 && <button onClick={() => moveUnits(c.contributors.map((x) => ({ id: x.unitId, kind: x.kind })), COLUMNS[ci - 1])}>←</button>}
                            {ci < COLUMNS.length - 1 && (
                              <button className="kanban-fwd" onClick={() => moveUnits(c.contributors.map((x) => ({ id: x.unitId, kind: x.kind })), COLUMNS[ci + 1])}>
                                {col === "생산대기" ? "생산 시작 →" : "생산 완료 ✓"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    companyItems.map((u) => {
                      const overdue = u.status !== "생산완료" && !!u.date && u.date < today;
                      return (
                        <div key={u.kind + u.id} className={`kanban-card ${overdue ? "is-overdue" : ""}`}>
                          <div className="kanban-card-top">
                            <span className="kanban-card-company">{u.company}{u.kind === "manual" && <span className="prod-side-manual-tag">직접</span>}</span>
                            {u.date && <span className={`kanban-card-date ${overdue ? "is-overdue" : ""}`}>{u.date.slice(5)}</span>}
                          </div>
                          <ul className="kanban-card-items">
                            {u.items.map((it, i) => (
                              <li key={i}><span className="ki-name">{it.name}{it.spec ? ` ${it.spec}` : ""}</span><span className="ki-qty">{it.qty.toLocaleString()}</span></li>
                            ))}
                          </ul>
                          <div className="kanban-card-actions">
                            {ci > 0 && <button onClick={() => moveUnits([{ id: u.id, kind: u.kind }], COLUMNS[ci - 1])}>←</button>}
                            {ci < COLUMNS.length - 1 && (
                              <button className="kanban-fwd" onClick={() => moveUnits([{ id: u.id, kind: u.kind }], COLUMNS[ci + 1])}>
                                {col === "생산대기" ? "생산 시작 →" : "생산 완료 ✓"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
