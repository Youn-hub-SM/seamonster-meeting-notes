"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Item = { name: string; spec: string; qty: number };
type Card = { id: string; kind: "order" | "manual"; status: string; company: string; orderNo: string | null; date: string | null; items: Item[] };

const COLUMNS = ["생산대기", "생산중", "생산완료"] as const;
const COL_COLOR: Record<string, string> = { "생산대기": "#6b7280", "생산중": "#b86e00", "생산완료": "#22863a" };

export default function ProductionBoardPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [today, setToday] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await (await fetch("/api/production/board", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setCards(j.cards || []);
      setToday(j.today || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function move(card: Card, status: string) {
    const prev = cards;
    setCards((cs) => cs.map((c) => (c.id === card.id && c.kind === card.kind ? { ...c, status } : c)));
    try {
      const url = card.kind === "order" ? `/api/b2b/orders/${card.id}` : `/api/production/manual`;
      const body = card.kind === "order" ? { production_status: status } : { id: card.id, status };
      const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "변경 실패");
    } catch (e) {
      setCards(prev);
      setError(e instanceof Error ? e.message : "변경 실패");
    }
  }

  const byCol = useMemo(() => {
    const m: Record<string, Card[]> = { "생산대기": [], "생산중": [], "생산완료": [] };
    for (const c of cards) (m[c.status] || m["생산대기"]).push(c);
    for (const k of COLUMNS) m[k].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    return m;
  }, [cards]);

  const overdueCount = useMemo(() => cards.filter((c) => c.status !== "생산완료" && c.date && c.date < today).length, [cards, today]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 보드</h1>
          <p className="b2b-page-subtitle">생산 전·중·완료를 한눈에 체크하고 카드를 옮겨 기록하세요. 생산일이 지났는데 안 만든 건이 곧 재고 쇼트입니다.</p>
        </div>
        <div className="b2b-page-actions">
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
          {COLUMNS.map((col) => (
            <div key={col} className="kanban-col">
              <div className="kanban-col-head" style={{ color: COL_COLOR[col] }}>
                {col} <span className="kanban-col-count">{byCol[col].length}</span>
              </div>
              <div className="kanban-col-body">
                {byCol[col].length === 0 ? (
                  <div className="kanban-empty">없음</div>
                ) : (
                  byCol[col].map((c) => {
                    const overdue = c.status !== "생산완료" && !!c.date && c.date < today;
                    const ci = COLUMNS.indexOf(col);
                    return (
                      <div key={c.kind + c.id} className={`kanban-card ${overdue ? "is-overdue" : ""}`}>
                        <div className="kanban-card-top">
                          <span className="kanban-card-company">
                            {c.company}
                            {c.kind === "manual" && <span className="prod-side-manual-tag">직접</span>}
                          </span>
                          {c.date && <span className={`kanban-card-date ${overdue ? "is-overdue" : ""}`}>{c.date.slice(5)}</span>}
                        </div>
                        <ul className="kanban-card-items">
                          {c.items.map((it, i) => (
                            <li key={i}>
                              <span className="ki-name">{it.name}{it.spec ? ` ${it.spec}` : ""}</span>
                              <span className="ki-qty">{it.qty.toLocaleString()}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="kanban-card-actions">
                          {ci > 0 && <button className="kanban-back" onClick={() => move(c, COLUMNS[ci - 1])}>←</button>}
                          {ci < COLUMNS.length - 1 && (
                            <button className="kanban-fwd" onClick={() => move(c, COLUMNS[ci + 1])}>
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
          ))}
        </div>
      )}
    </div>
  );
}
