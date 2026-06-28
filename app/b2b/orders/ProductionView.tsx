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

type Day = {
  date: string; // "" = 미정
  label: string;
  total_qty: number;
  order_count: number;
  products: ProductRow[];
};

export default function ProductionView() {
  const [days, setDays] = useState<Day[]>([]);
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
        setDays(j.days || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  const todayIso = todayISO();

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;
  if (error) return <div className="b2b-error">{error}</div>;
  if (days.length === 0) {
    return (
      <div className="b2b-empty">
        <div className="b2b-empty-icon">🏭</div>
        생산 대기·생산 중인 발주가 없습니다.
      </div>
    );
  }

  // 전체 합계(상단 요약)
  const grandQty = days.reduce((s, d) => s + d.total_qty, 0);
  const grandOrders = days.reduce((s, d) => s + d.order_count, 0);

  return (
    <div className="b2b-week-wrap">
      <p style={{ fontSize: 11, color: "var(--sm-text-light)", marginBottom: 12 }}>
        생산예정일(일자)별 · 생산대기·생산중 발주만 · 품목+옵션별 총수량 ·{" "}
        <strong style={{ color: "var(--sm-text-mid)" }}>
          합계 {grandOrders}건 / {formatQty(grandQty)}개
        </strong>
      </p>
      {days.map((d) => {
        const isToday = !!d.date && d.date === todayIso;
        const isOverdue = !!d.date && d.date < todayIso;
        const isUnscheduled = !d.date;
        return (
          <section
            key={d.date || "unscheduled"}
            className={`b2b-week-card ${isToday ? "is-current" : ""} ${isUnscheduled ? "is-unscheduled" : ""}`}
          >
            <div className="b2b-week-head">
              <div className="b2b-week-title-block">
                <h2 className="b2b-week-title">{d.label}</h2>
                {isToday && <span className="b2b-week-badge">오늘</span>}
                {isOverdue && (
                  <span className="b2b-week-badge" style={{ background: "#FCE4E4", color: "#C92A2A" }}>
                    지남
                  </span>
                )}
              </div>
              <div className="b2b-week-totals">
                <span><em>발주</em><strong>{d.order_count}건</strong></span>
                <span><em>품목</em><strong>{d.products.length}종</strong></span>
                <span><em>총 수량</em><strong>{formatQty(d.total_qty)}</strong></span>
              </div>
            </div>

            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th>옵션</th>
                    <th className="num">생산 수량</th>
                    <th>거래처</th>
                    <th className="num">발주 수</th>
                  </tr>
                </thead>
                <tbody>
                  {d.products.map((p) => (
                    <tr key={`${p.product_name}__${p.spec}`} style={{ cursor: "default" }}>
                      <td>{p.product_name}</td>
                      <td>{p.spec || "-"}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{formatQty(p.qty)}</td>
                      <td style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>
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

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
