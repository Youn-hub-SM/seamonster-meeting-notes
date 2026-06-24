"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ProductRow = {
  product_name: string;
  spec: string;
  qty: number;
  companies: string[];
  order_count: number;
};
type DayBucket = {
  date: string; // "" = 미정
  label: string;
  total_qty: number;
  order_count: number;
  products: ProductRow[];
};

function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

export default function ProductionSchedulePage() {
  const [days, setDays] = useState<DayBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const today = todayIso();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/orders/production-summary", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "생산일정 조회 실패");
      setDays(j.days || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    let qty = 0;
    let items = 0;
    let overdueQty = 0;
    for (const d of days) {
      qty += d.total_qty;
      items += d.products.length;
      if (d.date && d.date < today) overdueQty += d.total_qty;
    }
    return { qty, items, overdueQty };
  }, [days, today]);

  // 날짜 상태: 지연(과거) / 오늘 / 예정 / 미정
  function dayState(date: string): "overdue" | "today" | "upcoming" | "unset" {
    if (!date) return "unset";
    if (date < today) return "overdue";
    if (date === today) return "today";
    return "upcoming";
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산일정</h1>
          <p className="b2b-page-subtitle">
            생산이 필요한 발주(생산대기·생산중)를 생산예정일 순으로 모았습니다. 무엇을 며칠에 몇 개 만들어야 하는지 확인하세요.
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">생산 필요 품목</div>
          <div className="b2b-stat-card-value">{totals.items}종</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">총 생산 수량</div>
          <div className="b2b-stat-card-value">{totals.qty.toLocaleString()}</div>
        </div>
        <div className="b2b-stat-card" style={totals.overdueQty > 0 ? { borderColor: "#f5c6c6" } : undefined}>
          <div className="b2b-stat-card-label" style={totals.overdueQty > 0 ? { color: "#c92a2a" } : undefined}>
            지연(생산일 지남)
          </div>
          <div className="b2b-stat-card-value" style={totals.overdueQty > 0 ? { color: "#c92a2a" } : undefined}>
            {totals.overdueQty.toLocaleString()}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : days.length === 0 ? (
        <div className="b2b-empty">
          <div className="b2b-empty-icon">🏭</div>
          생산이 필요한 발주가 없습니다.
        </div>
      ) : (
        <div className="prod-day-list">
          {days.map((d) => {
            const st = dayState(d.date);
            return (
              <section key={d.date || "unset"} className={`prod-day-card is-${st}`}>
                <div className="prod-day-head">
                  <div className="prod-day-when">
                    <span className="prod-day-label">{d.label}</span>
                    {st === "overdue" && <span className="prod-day-badge is-overdue">지연</span>}
                    {st === "today" && <span className="prod-day-badge is-today">오늘</span>}
                    {st === "unset" && <span className="prod-day-badge is-unset">날짜 미정</span>}
                  </div>
                  <div className="prod-day-sum">
                    <span>{d.products.length}종</span>
                    <span className="prod-day-sum-qty">{d.total_qty.toLocaleString()}개</span>
                  </div>
                </div>
                <div className="b2b-table-wrap">
                  <table className="b2b-table prod-table">
                    <thead>
                      <tr>
                        <th>품목</th>
                        <th>규격</th>
                        <th className="num">생산 수량</th>
                        <th>주문처</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.products.map((p, i) => (
                        <tr key={i}>
                          <td>{p.product_name}</td>
                          <td>{p.spec || "-"}</td>
                          <td className="num"><strong>{p.qty.toLocaleString()}</strong></td>
                          <td>
                            <span className="prod-companies">
                              {p.companies.join(", ") || "-"}
                              {p.order_count > 1 && <span className="prod-ordcount"> · {p.order_count}건</span>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="prod-note">
        ※ 박스히어로 재고를 연동하면 “현재고를 뺀 실제 생산 필요량”과 판매추세 기반 조언이 추가됩니다. (Phase 2)
      </p>
    </div>
  );
}
