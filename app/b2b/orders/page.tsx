"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  OrderListItem,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  TAX_INVOICE_STATUSES,
  OrderStatus,
  PaymentStatus,
  TaxInvoiceStatus,
  STATUS_COLORS,
  STATUS_SHORT,
  PAYMENT_COLORS,
  TAX_INVOICE_COLORS,
  formatMoney,
  getUrgency,
  todayISO,
  URGENCY_LABEL,
} from "@/app/lib/b2b-orders";
import { Company } from "@/app/lib/b2b-types";
import CalendarView from "./CalendarView";
import WeeklyView from "./WeeklyView";

type View = "list" | "calendar" | "weekly";

export default function OrdersListPage() {
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("list");
  const [statusFilter, setStatusFilter] = useState<"전체" | OrderStatus>("전체");
  const [companyFilter, setCompanyFilter] = useState<string>(""); // ""=전체
  const [taxInvoiceFilter, setTaxInvoiceFilter] = useState<"전체" | TaxInvoiceStatus>("전체");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const today = useMemo(() => todayISO(), []);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const [ordersRes, compRes] = await Promise.all([
        fetch("/api/b2b/orders", { cache: "no-store" }),
        fetch("/api/b2b/companies", { cache: "no-store" }),
      ]);
      const ordersJson = await ordersRes.json();
      const compJson = await compRes.json();
      if (!ordersJson.ok) throw new Error(ordersJson.error || "발주 조회 실패");
      if (!compJson.ok) throw new Error(compJson.error || "업체 조회 실패");
      setOrders(ordersJson.orders || []);
      setCompanies(compJson.companies || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    let arr = orders;
    if (statusFilter !== "전체") arr = arr.filter((o) => o.status === statusFilter);
    if (companyFilter) arr = arr.filter((o) => o.company_id === companyFilter);
    if (taxInvoiceFilter !== "전체") arr = arr.filter((o) => o.tax_invoice_status === taxInvoiceFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((o) =>
        [o.order_no, o.company_name, o.notes].filter(Boolean).some((v) => v!.toLowerCase().includes(q))
      );
    }
    return arr;
  }, [orders, statusFilter, companyFilter, taxInvoiceFilter, search]);

  // 지연/임박 카운트 (배너용)
  const urgencyCount = useMemo(() => {
    let overdue = 0,
      urgent = 0;
    for (const o of orders) {
      const u = getUrgency(o, today);
      if (u === "overdue") overdue++;
      else if (u === "urgent") urgent++;
    }
    return { overdue, urgent };
  }, [orders, today]);

  async function handleStatusChange(id: string, newStatus: OrderStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.status === newStatus) return;

    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o)));

    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "상태 변경 실패");
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "상태 변경 오류");
    }
  }

  function toggleSelectOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const filteredIds = new Set(filtered.map((o) => o.id));
      const allSelected = filtered.length > 0 && filtered.every((o) => prev.has(o.id));
      if (allSelected) {
        // 현재 보이는 것 전체 해제
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      // 현재 보이는 것 전체 추가
      const next = new Set(prev);
      filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function handleExportShipping() {
    if (selected.size === 0) return;
    setExporting(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/orders/export-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_ids: Array.from(selected) }),
      });
      if (!res.ok) {
        const text = await res.text();
        try {
          const j = JSON.parse(text);
          throw new Error(j.error || "다운로드 실패");
        } catch {
          throw new Error("다운로드 실패 (HTTP " + res.status + ")");
        }
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/);
      a.download = m ? m[1] : "shipping-request.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "다운로드 중 오류");
    }
    setExporting(false);
  }

  async function handleTaxInvoiceChange(id: string, newStatus: TaxInvoiceStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.tax_invoice_status === newStatus) return;
    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, tax_invoice_status: newStatus } : o)));
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_invoice_status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "세금계산서 상태 변경 실패");
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "세금계산서 상태 변경 오류");
    }
  }

  async function handlePaymentChange(id: string, newStatus: PaymentStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.payment_status === newStatus) return;
    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, payment_status: newStatus } : o)));
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "입금 상태 변경 실패");
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "입금 상태 변경 오류");
    }
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">발주 관리</h1>
          <p className="b2b-page-subtitle">
            발주·생산·발송 일정과 입금 상태를 한 화면에서 관리합니다.
            {orders.length > 0 && ` (전체 ${orders.length}건)`}
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <Link href="/b2b/orders/new" className="b2b-btn-primary">
            + 새 발주
          </Link>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {(urgencyCount.overdue > 0 || urgencyCount.urgent > 0) && (
        <div className="b2b-urgency-banner">
          {urgencyCount.overdue > 0 && (
            <span className="b2b-urgency-pill is-overdue">
              지연 {urgencyCount.overdue}건
            </span>
          )}
          {urgencyCount.urgent > 0 && (
            <span className="b2b-urgency-pill is-urgent">
              임박 {urgencyCount.urgent}건
            </span>
          )}
        </div>
      )}

      <div className="b2b-view-tabs">
        <button
          type="button"
          className={`b2b-view-tab ${view === "list" ? "is-active" : ""}`}
          onClick={() => setView("list")}
        >
          목록
        </button>
        <button
          type="button"
          className={`b2b-view-tab ${view === "calendar" ? "is-active" : ""}`}
          onClick={() => setView("calendar")}
        >
          캘린더
        </button>
        <button
          type="button"
          className={`b2b-view-tab ${view === "weekly" ? "is-active" : ""}`}
          onClick={() => setView("weekly")}
        >
          주간 (발송일)
        </button>
      </div>

      <div className="b2b-card">
        <div className="b2b-card-head" style={{ gap: 12, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <input
            type="text"
            className="b2b-search"
            placeholder="발주번호·업체·메모 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 280 }}
          />
          <select
            className="b2b-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            style={{ width: "auto", maxWidth: 180 }}
          >
            <option value="전체">전체 상태</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            className="b2b-select"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            style={{ width: "auto", maxWidth: 220 }}
          >
            <option value="">전체 업체</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            className="b2b-select"
            value={taxInvoiceFilter}
            onChange={(e) => setTaxInvoiceFilter(e.target.value as typeof taxInvoiceFilter)}
            style={{ width: "auto", maxWidth: 160 }}
            title="세금계산서 상태"
          >
            <option value="전체">전체 세금계산서</option>
            {TAX_INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>세금계산서 {s}</option>
            ))}
          </select>
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--sm-text-light)" }}>
            {filtered.length}건
          </span>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">📋</div>
            {orders.length === 0 ? (
              <>
                등록된 발주가 없습니다.
                <br />
                <Link href="/b2b/orders/new" style={{ color: "var(--sm-orange)", fontWeight: 600 }}>
                  + 첫 발주 등록하기
                </Link>
              </>
            ) : (
              "검색 결과가 없습니다."
            )}
          </div>
        ) : view === "calendar" ? (
          <CalendarView orders={filtered} todayIso={today} />
        ) : view === "weekly" ? (
          <WeeklyView orders={filtered} todayIso={today} />
        ) : (
          <>
            {selected.size > 0 && (
              <div className="b2b-selection-bar">
                <span>
                  <strong>{selected.size}건</strong> 선택됨
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="b2b-btn-secondary"
                    onClick={() => setSelected(new Set())}
                  >
                    선택 해제
                  </button>
                  <button
                    type="button"
                    className="b2b-btn-primary"
                    onClick={handleExportShipping}
                    disabled={exporting}
                  >
                    {exporting ? "생성 중..." : "발송요청 양식 다운로드"}
                  </button>
                </div>
              </div>
            )}
            <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every((o) => selected.has(o.id))}
                      onChange={toggleSelectAll}
                      title="이 페이지의 발주 전체 선택"
                    />
                  </th>
                  <th style={{ width: 1 }}></th>
                  <th>발주번호</th>
                  <th>업체</th>
                  <th>발주일</th>
                  <th>생산일</th>
                  <th>발송일</th>
                  <th className="num">합계</th>
                  <th>상태</th>
                  <th>입금</th>
                  <th>세금계산서</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const urgency = getUrgency(o, today);
                  return (
                    <tr key={o.id} className={urgency !== "normal" ? `is-${urgency}` : ""}>
                      <td onClick={(e) => e.stopPropagation()} style={{ padding: "8px 4px" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(o.id)}
                          onChange={() => toggleSelectOne(o.id)}
                        />
                      </td>
                      <td className="cell-flag" style={{ padding: "8px 4px" }}>
                        {urgency !== "normal" && (
                          <span className={`b2b-urgency-pill is-${urgency}`}>
                            {URGENCY_LABEL[urgency]}
                          </span>
                        )}
                      </td>
                      <RowCell href={`/b2b/orders/${o.id}`}>
                        <strong>{o.order_no}</strong>
                        {o.item_count > 1 && (
                          <span style={{ marginLeft: 8, fontSize: 12, color: "var(--sm-text-light)" }}>
                            라인 {o.item_count}
                          </span>
                        )}
                      </RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`}>{o.company_name}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`}>{o.order_date}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`}>{o.production_date || "-"}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`}>{o.ship_date || "-"}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`} className="num b2b-money">
                        {formatMoney(o.total)}
                      </RowCell>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="b2b-status-select"
                          value={o.status}
                          onChange={(e) => handleStatusChange(o.id, e.target.value as OrderStatus)}
                          style={{
                            background: STATUS_COLORS[o.status]?.bg,
                            color: STATUS_COLORS[o.status]?.fg,
                          }}
                        >
                          {ORDER_STATUSES.map((s) => (
                            <option key={s} value={s}>{STATUS_SHORT[s] || s}</option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="b2b-status-select"
                          value={o.payment_status}
                          onChange={(e) => handlePaymentChange(o.id, e.target.value as PaymentStatus)}
                          style={{
                            background: PAYMENT_COLORS[o.payment_status]?.bg,
                            color: PAYMENT_COLORS[o.payment_status]?.fg,
                          }}
                        >
                          {PAYMENT_STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="b2b-status-select"
                          value={o.tax_invoice_status}
                          onChange={(e) => handleTaxInvoiceChange(o.id, e.target.value as TaxInvoiceStatus)}
                          style={{
                            background: TAX_INVOICE_COLORS[o.tax_invoice_status]?.bg,
                            color: TAX_INVOICE_COLORS[o.tax_invoice_status]?.fg,
                          }}
                        >
                          {TAX_INVOICE_STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// 셀 안의 <a> 가 전체 셀 영역 클릭되도록 — display:block + 셀 padding 0
function RowCell({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <td className={className} style={{ padding: 0 }}>
      <Link href={href} className="b2b-row-link" style={{ display: "block", padding: "12px 14px" }}>
        {children}
      </Link>
    </td>
  );
}
