"use client";

import { useEffect, useState } from "react";
import { formatQty } from "@/app/lib/b2b-orders";

type ProductRow = {
  product_name: string;
  spec: string;
  qty: number;
  companies: string[];
  order_count: number;
};

type Week = {
  week_start: string;
  week_end: string;
  label: string;
  total_qty: number;
  order_count: number;
  products: ProductRow[];
};

export default function ProductionView() {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/b2b/orders/production-summary", { cache: "no-store" });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setWeeks(j.weeks || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  const thisWeekStart = thisMonday();

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;
  if (error) return <div className="b2b-error">{error}</div>;
  if (weeks.length === 0) {
    return (
      <div className="b2b-empty">
        <div className="b2b-empty-icon">🏭</div>
        생산 대기·생산 중인 발주가 없습니다.
      </div>
    );
  }

  return (
    <div className="b2b-week-wrap">
      <p style={{ fontSize: 13, color: "var(--sm-text-light)", marginBottom: 4 }}>
        생산예정일 기준 · 생산대기·생산중 발주만 · 품목+규격별 총수량
      </p>
      {weeks.map((w) => {
        const isCurrent = w.week_start === thisWeekStart;
        const isUnscheduled = !w.week_start;
        return (
          <section
            key={w.week_start || "unscheduled"}
            className={`b2b-week-card ${isCurrent ? "is-current" : ""} ${isUnscheduled ? "is-unscheduled" : ""}`}
          >
            <div className="b2b-week-head">
              <div className="b2b-week-title-block">
                <h2 className="b2b-week-title">{w.label}</h2>
                {isCurrent && <span className="b2b-week-badge">이번 주</span>}
              </div>
              <div className="b2b-week-totals">
                <span><em>발주</em><strong>{w.order_count}건</strong></span>
                <span><em>품목</em><strong>{w.products.length}종</strong></span>
                <span><em>총 수량</em><strong>{formatQty(w.total_qty)}</strong></span>
              </div>
            </div>

            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th>옵션</th>
                    <th className="num">총 수량</th>
                    <th>거래처</th>
                    <th className="num">발주 수</th>
                  </tr>
                </thead>
                <tbody>
                  {w.products.map((p) => (
                    <tr key={`${p.product_name}__${p.spec}`} style={{ cursor: "default" }}>
                      <td><strong>{p.product_name}</strong></td>
                      <td>{p.spec || "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{formatQty(p.qty)}</td>
                      <td style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>
                        {p.companies.length > 0 ? p.companies.join(", ") : "-"}
                      </td>
                      <td className="num">{p.order_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function thisMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
