"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Company, formatPhone, formatBizNo } from "@/app/lib/b2b-types";
import {
  STATUS_COLORS,
  STATUS_SHORT,
  PAYMENT_COLORS,
  OrderStatus,
  PaymentStatus,
  formatMoney,
  formatQty,
} from "@/app/lib/b2b-orders";

type OrderLine = { product_name: string; spec: string | null; qty: number };
type OrderRow = {
  id: string;
  order_no: string;
  order_date: string;
  ship_date: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  total: number;
  items: OrderLine[];
};
type TopProduct = { product_name: string; qty: number; orders: number };
type Detail = {
  company: Company;
  orders: OrderRow[];
  summary: { order_count: number; revenue: number; outstanding: number; unpaid_count: number };
  top_products: TopProduct[];
};

export default function CompanyDetail({ companyId }: { companyId: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/b2b/companies/${companyId}`, { cache: "no-store" });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setData(j);
      } catch (err) {
        setError(err instanceof Error ? err.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, [companyId]);

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;
  if (error) return <div className="b2b-error">{error}</div>;
  if (!data) return <div className="b2b-empty">데이터 없음</div>;

  const c = data.company;

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">{c.name}</h1>
          <p className="b2b-page-subtitle">
            {[formatBizNo(c.biz_no), c.contact_name && `담당 ${c.contact_name}`, formatPhone(c.contact_phone), c.payment_terms]
              .filter(Boolean)
              .join(" · ") || "거래처 상세"}
          </p>
        </div>
        <div className="b2b-page-actions">
          <Link href="/b2b/companies" className="b2b-btn-secondary">주소록으로</Link>
        </div>
      </header>

      {/* 집계 카드 */}
      <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">총 발주</div>
          <div className="b2b-stat-card-value">{data.summary.order_count}건</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">누적 매출 (발송완료)</div>
          <div className="b2b-stat-card-value b2b-money">{formatMoney(data.summary.revenue)}</div>
        </div>
        <div className="b2b-stat-card" style={data.summary.outstanding > 0 ? { borderColor: "#f5c6c6" } : undefined}>
          <div className="b2b-stat-card-label" style={data.summary.outstanding > 0 ? { color: "#c92a2a" } : undefined}>미수금</div>
          <div className="b2b-stat-card-value b2b-money" style={data.summary.outstanding > 0 ? { color: "#c92a2a" } : undefined}>
            {formatMoney(data.summary.outstanding)}
          </div>
          {data.summary.unpaid_count > 0 && (
            <div className="b2b-stat-card-hint">{data.summary.unpaid_count}건 미입금/부분입금</div>
          )}
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">기본 배송지</div>
          <div style={{ fontSize: 13, color: "var(--sm-dark)", marginTop: 6, lineHeight: 1.5 }}>
            {c.address || <span style={{ color: "var(--sm-text-light)" }}>미등록</span>}
          </div>
        </div>
      </div>

      {/* 주력 품목 */}
      {data.top_products.length > 0 && (
        <section className="b2b-card" style={{ marginBottom: 16 }}>
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">주력 품목 (누적 수량순)</h2>
          </div>
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead>
                <tr>
                  <th>품목</th>
                  <th className="num">누적 수량</th>
                  <th className="num">발주 건수</th>
                </tr>
              </thead>
              <tbody>
                {data.top_products.map((p) => (
                  <tr key={p.product_name} style={{ cursor: "default" }}>
                    <td><strong>{p.product_name}</strong></td>
                    <td className="num">{formatQty(p.qty)}</td>
                    <td className="num">{p.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 발주 이력 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">발주 이력</h2>
          <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>{data.orders.length}건</span>
        </div>
        {data.orders.length === 0 ? (
          <div className="b2b-empty">이 거래처의 발주가 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead>
                <tr>
                  <th>발주번호</th>
                  <th>품목</th>
                  <th>발주일</th>
                  <th>발송일</th>
                  <th className="num">합계</th>
                  <th>상태</th>
                  <th>입금</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} style={{ cursor: "default" }}>
                    <td style={{ padding: 0 }}>
                      <Link href={`/b2b/orders/${o.id}`} className="b2b-row-link" style={{ display: "block", padding: "12px 14px" }}>
                        <strong>{o.order_no}</strong>
                      </Link>
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {o.items.length === 0
                        ? "-"
                        : o.items.slice(0, 2).map((it, i) => (
                            <span key={i}>
                              {i > 0 && ", "}
                              {it.product_name}{it.spec ? ` ${it.spec}` : ""} ×{it.qty}
                            </span>
                          ))}
                      {o.items.length > 2 && <span style={{ color: "var(--sm-text-light)" }}> 외 {o.items.length - 2}종</span>}
                    </td>
                    <td>{o.order_date}</td>
                    <td>{o.ship_date || "-"}</td>
                    <td className="num b2b-money">{formatMoney(o.total)}</td>
                    <td>
                      <span className="b2b-status-pill" style={{ background: STATUS_COLORS[o.status]?.bg, color: STATUS_COLORS[o.status]?.fg }}>
                        {STATUS_SHORT[o.status] || o.status}
                      </span>
                    </td>
                    <td>
                      <span className="b2b-status-pill" style={{ background: PAYMENT_COLORS[o.payment_status]?.bg, color: PAYMENT_COLORS[o.payment_status]?.fg }}>
                        {o.payment_status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
