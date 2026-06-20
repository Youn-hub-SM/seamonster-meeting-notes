"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  OrderListItem,
  OrderLinePreview,
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
  SHIPMENT_STATUS_COLORS,
  SHIPMENT_STATUSES,
  ShipmentStatus,
  ShipmentDatePreview,
  formatMoney,
  formatQty,
  getUrgency,
  isOrderComplete,
  nextPendingShipDate,
  splitTracking,
  joinTracking,
  todayISO,
  URGENCY_LABEL,
  OrderExportOption,
  ShipmentExportOption,
  ExportLineItem,
} from "@/app/lib/b2b-orders";
import { Company } from "@/app/lib/b2b-types";
import CalendarView from "./CalendarView";
import WeeklyView from "./WeeklyView";
import ProductionView from "./ProductionView";
import { pingActivityFeed } from "../ActivityFeed";

type View = "list" | "calendar" | "weekly" | "production";

export default function OrdersListPage() {
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("list");
  // 엑셀 필터식 체크박스 다중선택 (체크된 상태만 표시). 기본=전체 체크.
  const [statusSel, setStatusSel] = useState<Set<OrderStatus>>(() => new Set(ORDER_STATUSES));
  const [paymentSel, setPaymentSel] = useState<Set<PaymentStatus>>(() => new Set(PAYMENT_STATUSES));
  const [taxSel, setTaxSel] = useState<Set<TaxInvoiceStatus>>(() => new Set(TAX_INVOICE_STATUSES));
  const [companyFilter, setCompanyFilter] = useState<string>(""); // ""=전체
  const [productFilter, setProductFilter] = useState<string>(""); // ""=전체
  const [hideComplete, setHideComplete] = useState(false); // 완료(발송·입금·발행 다 끝) 숨기기
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [exportOptions, setExportOptions] = useState<OrderExportOption[] | null>(null);
  // 발송완료 변경 시 송장번호 입력 프롬프트 (발주 or 발송 차수)
  //  boxCount 만큼 송장 입력칸을 띄움 (박스당 1개).
  const [trackingPrompt, setTrackingPrompt] = useState<
    | { kind: "order"; id: string; label: string; boxCount: number }
    | { kind: "shipment"; id: string; orderId: string; label: string; boxCount: number }
    | null
  >(null);
  const [trackingInput, setTrackingInput] = useState<string[]>([""]);
  // 직접 배송(택배 아님) — 체크 시 송장번호 없이 발송완료 가능
  const [directDelivery, setDirectDelivery] = useState(false);
  // 접힌 상위발주(복수발송) — 기본 펼침이라 여기에 담긴 것만 접힘
  // 복수발송 하위 차수 — 기본은 접힘. 사용자가 펼친 발주 id만 여기에 담김.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── 필터 유지 (로그인 사용자별 localStorage) ──
  //  초기화 버튼을 누르기 전까지 페이지를 떠났다 와도 필터가 유지됨.
  const [filterUser, setFilterUser] = useState<string | null>(null);
  const [filterRestored, setFilterRestored] = useState(false);
  const filterStoreKey = filterUser ? `b2b:orders:filters:${filterUser}` : null;

  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setFilterUser(j.ok && j.name ? j.name : "공용"))
      .catch(() => setFilterUser("공용"));
  }, []);

  // 복원 (사용자 확인 후 1회). setState 가 적용된 다음 렌더부터 저장 effect 가 동작하도록
  // filterRestored 는 state 로 — 복원 전에 기본값이 저장본을 덮어쓰는 걸 방지.
  useEffect(() => {
    if (!filterStoreKey) return;
    try {
      const raw = localStorage.getItem(filterStoreKey);
      if (raw) {
        const s = JSON.parse(raw) as {
          v?: number;
          status?: string[];
          payment?: string[];
          tax?: string[];
          company?: string;
          product?: string;
          hideComplete?: boolean;
          search?: string;
        };
        if (s && s.v === 1) {
          if (Array.isArray(s.status))
            setStatusSel(new Set(s.status.filter((x): x is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(x))));
          if (Array.isArray(s.payment))
            setPaymentSel(new Set(s.payment.filter((x): x is PaymentStatus => (PAYMENT_STATUSES as readonly string[]).includes(x))));
          if (Array.isArray(s.tax))
            setTaxSel(new Set(s.tax.filter((x): x is TaxInvoiceStatus => (TAX_INVOICE_STATUSES as readonly string[]).includes(x))));
          if (typeof s.company === "string") setCompanyFilter(s.company);
          if (typeof s.product === "string") setProductFilter(s.product);
          if (typeof s.hideComplete === "boolean") setHideComplete(s.hideComplete);
          if (typeof s.search === "string") setSearch(s.search);
        }
      }
    } catch {
      // 저장본이 깨졌으면 무시하고 기본값 사용
    }
    setFilterRestored(true);
  }, [filterStoreKey]);

  // 저장 — 필터가 바뀔 때마다 (복원 완료 후에만)
  useEffect(() => {
    if (!filterStoreKey || !filterRestored) return;
    try {
      localStorage.setItem(
        filterStoreKey,
        JSON.stringify({
          v: 1,
          status: Array.from(statusSel),
          payment: Array.from(paymentSel),
          tax: Array.from(taxSel),
          company: companyFilter,
          product: productFilter,
          hideComplete,
          search,
        })
      );
    } catch {
      // 저장 실패(시크릿 모드 등)는 무시 — 기능엔 영향 없음
    }
  }, [filterStoreKey, filterRestored, statusSel, paymentSel, taxSel, companyFilter, productFilter, hideComplete, search]);

  function resetFilters() {
    setStatusSel(new Set(ORDER_STATUSES));
    setCompanyFilter("");
    setTaxSel(new Set(TAX_INVOICE_STATUSES));
    setPaymentSel(new Set(PAYMENT_STATUSES));
    setProductFilter("");
    setHideComplete(false);
    setSearch("");
    if (filterStoreKey) {
      try { localStorage.removeItem(filterStoreKey); } catch {}
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  // 전체 발주의 품목명 목록 (제품 필터 드롭다운용)
  const productNames = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) for (const it of o.items || []) if (it.product_name) set.add(it.product_name);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  }, [orders]);

  // 체크박스 필터가 전체 선택 상태인지 (전체면 그 필터는 적용 안 한 것과 동일)
  const statusAll = statusSel.size === ORDER_STATUSES.length;
  const paymentAll = paymentSel.size === PAYMENT_STATUSES.length;
  const taxAll = taxSel.size === TAX_INVOICE_STATUSES.length;

  const filtered = useMemo(() => {
    let arr = orders;
    if (!statusAll) arr = arr.filter((o) => statusSel.has(o.status));
    if (!paymentAll) arr = arr.filter((o) => paymentSel.has(o.payment_status));
    if (!taxAll) arr = arr.filter((o) => taxSel.has(o.tax_invoice_status));
    if (companyFilter) arr = arr.filter((o) => o.company_id === companyFilter);
    if (productFilter) arr = arr.filter((o) => (o.items || []).some((it) => it.product_name === productFilter));
    if (hideComplete) arr = arr.filter((o) => !isOrderComplete(o));
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((o) =>
        [o.order_no, o.company_name, o.notes].filter(Boolean).some((v) => v!.toLowerCase().includes(q)) ||
        (o.items || []).some((it) => it.product_name.toLowerCase().includes(q))
      );
    }
    return arr;
  }, [orders, statusSel, paymentSel, taxSel, statusAll, paymentAll, taxAll, companyFilter, productFilter, hideComplete, search]);

  // 지연/임박 카운트 (배너용)
  const urgencyCount = useMemo(() => {
    let overdue = 0,
      urgent = 0;
    for (const o of orders) {
      const u = getUrgency({ ...o, ship_date: nextPendingShipDate(o) }, today);
      if (u === "overdue") overdue++;
      else if (u === "urgent") urgent++;
    }
    return { overdue, urgent };
  }, [orders, today]);

  async function handleStatusChange(id: string, newStatus: OrderStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.status === newStatus) return;
    // 발송완료로 바꾸는데 송장번호가 없으면 입력 프롬프트 (박스 수만큼 칸)
    if (newStatus === "발송완료" && !String(target.tracking_no ?? "").trim()) {
      const boxCount = Math.max(1, Number(target.box_count) || 1);
      setTrackingInput(splitTracking(target.tracking_no, boxCount));
      setDirectDelivery(false);
      setTrackingPrompt({ kind: "order", id, label: target.order_no, boxCount });
      return;
    }
    await patchStatus(id, newStatus);
  }

  async function patchStatus(id: string, newStatus: OrderStatus, trackingNo?: string) {
    const snapshot = orders;
    setOrders((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) } : o))
    );
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "상태 변경 오류");
    }
  }

  // 발송완료 처리 가능 여부: 직접 배송이거나, 박스 수만큼 송장이 다 채워졌을 때
  const trackingComplete =
    directDelivery || (trackingInput.length > 0 && trackingInput.every((t) => t.trim() !== ""));

  async function confirmTracking() {
    if (!trackingPrompt || !trackingComplete) return;
    // 직접 배송이면 송장 자리에 '직접배송' 마커 저장
    const tracking = directDelivery ? "직접배송" : joinTracking(trackingInput);
    const p = trackingPrompt;
    setTrackingPrompt(null);
    setDirectDelivery(false);
    if (p.kind === "order") await patchStatus(p.id, "발송완료", tracking);
    else await patchShipment(p.orderId, p.id, "발송완료", tracking);
  }

  // 하위 차수(발송 일정) 상태 변경 — 발송완료면 송장번호 필요 (박스 수만큼 칸)
  function handleShipmentStatus(o: OrderListItem, ship: ShipmentDatePreview, newStatus: ShipmentStatus) {
    if (ship.status === newStatus) return;
    if (newStatus === "발송완료" && !String(ship.tracking_no ?? "").trim()) {
      const boxCount = Math.max(1, Number(ship.box_count) || 1);
      setTrackingInput(splitTracking(ship.tracking_no, boxCount));
      setDirectDelivery(false);
      setTrackingPrompt({ kind: "shipment", id: ship.id, orderId: o.id, label: `${o.order_no} · ${ship.seq}차 발송`, boxCount });
      return;
    }
    void patchShipment(o.id, ship.id, newStatus);
  }

  async function patchShipment(orderId: string, shipmentId: string, newStatus: ShipmentStatus, trackingNo?: string) {
    const snapshot = orders;
    setOrders((prev) =>
      prev.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              shipments: (o.shipments ?? []).map((s) =>
                s.id !== shipmentId ? s : { ...s, status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) }
              ),
            }
      )
    );
    try {
      const res = await fetch(`/api/b2b/shipments/${shipmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "발송 상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "발송 상태 변경 오류");
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

  async function handleBulkStatus(newStatus: OrderStatus) {
    if (selected.size === 0) return;
    // 발송완료는 발주마다 송장번호가 달라 일괄 변경 불가 — 개별로 처리
    if (newStatus === "발송완료") {
      setError("발송완료는 송장번호가 발주마다 달라 일괄 변경할 수 없습니다. 발주별로 변경해주세요.");
      return;
    }
    const ids = Array.from(selected);
    if (!confirm(`선택한 ${ids.length}건의 발주 상태를 "${newStatus}" 로 변경할까요?`)) return;
    setBulkSaving(true);
    setError("");
    const snapshot = orders;
    // Optimistic
    setOrders((prev) => prev.map((o) => (selected.has(o.id) ? { ...o, status: newStatus } : o)));
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/b2b/orders/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus }),
          }).then((r) => r.ok)
        )
      );
      const failed = results.filter((ok) => !ok).length;
      if (failed > 0) {
        setOrders(snapshot);
        setError(`${failed}건 변경 실패 — 다시 시도해주세요.`);
      } else {
        setSelected(new Set());
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "일괄 변경 오류");
    }
    setBulkSaving(false);
  }

  // 실제 xlsx 다운로드 (발송 단위 shipment_ids + 과거 발주 order_ids)
  async function downloadShipping(payload: { shipment_ids?: string[]; order_ids?: string[] }) {
    setExporting(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/orders/export-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      setExportOptions(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "다운로드 중 오류");
    }
    setExporting(false);
  }

  // 선택한 발주 중 분할 발송(일정 2개 이상)이 있으면 선택 모달, 없으면 바로 다운로드
  async function handleExportShipping() {
    if (selected.size === 0) return;
    setExporting(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/orders/export-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_ids: Array.from(selected) }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "발송 정보 조회 실패");
      const options: OrderExportOption[] = json.options || [];

      const needsChoice = options.some((o) => o.shipments.length >= 2);
      if (needsChoice) {
        setExporting(false);
        setExportOptions(options); // 모달 오픈
        return;
      }

      // 분할 없음 → 발송(취소 제외) / 발송없는 과거발주는 발주 단위로 바로 출력
      const shipment_ids: string[] = [];
      const order_ids: string[] = [];
      for (const o of options) {
        if (o.shipments.length === 0) order_ids.push(o.order_id);
        else for (const s of o.shipments) if (s.status !== "취소") shipment_ids.push(s.id);
      }
      await downloadShipping({ shipment_ids, order_ids });
    } catch (err) {
      setError(err instanceof Error ? err.message : "다운로드 중 오류");
      setExporting(false);
    }
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
      } else {
        pingActivityFeed();
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
      } else {
        pingActivityFeed();
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
        <button
          type="button"
          className={`b2b-view-tab ${view === "production" ? "is-active" : ""}`}
          onClick={() => setView("production")}
        >
          생산 집계
        </button>
      </div>

      {view === "production" ? (
        <ProductionView />
      ) : (
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
          <CheckFilter label="상태" options={ORDER_STATUSES} selected={statusSel} onChange={setStatusSel} />
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
          <CheckFilter label="입금" options={PAYMENT_STATUSES} selected={paymentSel} onChange={setPaymentSel} />
          <CheckFilter label="세금계산서" options={TAX_INVOICE_STATUSES} selected={taxSel} onChange={setTaxSel} />
          <select
            className="b2b-select"
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            style={{ width: "auto", maxWidth: 200 }}
            title="품목 포함 필터"
          >
            <option value="">전체 품목</option>
            {productNames.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <label
            className={`b2b-hidecomplete ${hideComplete ? "is-on" : ""}`}
            title="발송·입금·세금계산서가 모두 끝난 발주 숨기기"
          >
            <input
              type="checkbox"
              checked={hideComplete}
              onChange={(e) => setHideComplete(e.target.checked)}
            />
            완료 숨기기
          </label>
          {(!statusAll || companyFilter || !taxAll || !paymentAll || productFilter || hideComplete || search) && (
            <button
              type="button"
              className="b2b-btn-secondary"
              style={{ padding: "6px 12px", fontSize: 13 }}
              onClick={resetFilters}
            >
              필터 초기화
            </button>
          )}
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
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    className="b2b-select"
                    value=""
                    disabled={bulkSaving}
                    onChange={(e) => {
                      if (e.target.value) handleBulkStatus(e.target.value as OrderStatus);
                      e.target.value = "";
                    }}
                    style={{ width: "auto" }}
                    title="선택한 발주의 상태를 한 번에 변경"
                  >
                    <option value="">{bulkSaving ? "변경 중..." : "상태 일괄 변경 →"}</option>
                    {ORDER_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
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
            <div className="b2b-table-wrap b2b-orders-table-wrap">
            <table className="b2b-table">
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      className="b2b-checkbox"
                      checked={filtered.length > 0 && filtered.every((o) => selected.has(o.id))}
                      onChange={toggleSelectAll}
                      title="이 페이지의 발주 전체 선택"
                    />
                  </th>
                  <th style={{ width: 1 }}></th>
                  <th style={{ minWidth: 88 }}>업체</th>
                  <th style={{ minWidth: 150 }}>품목</th>
                  <th className="b2b-col-date">발주일</th>
                  <th className="b2b-col-date">생산일</th>
                  <th className="b2b-col-date">발송일</th>
                  <th className="num">합계</th>
                  <th>상태</th>
                  <th>입금</th>
                  <th>세금계산서</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const urgency = getUrgency({ ...o, ship_date: nextPendingShipDate(o) }, today);
                  const parent = isParentOrder(o);
                  const prog = parent ? shipProgress(o) : null;
                  const isCollapsed = !expanded.has(o.id); // 기본 접힘
                  const complete = isOrderComplete(o);
                  return (
                    <Fragment key={o.id}>
                    <tr className={`${urgency !== "normal" ? `is-${urgency}` : ""} ${parent ? "is-parent" : ""}`}>
                      <td
                        onClick={(e) => {
                          e.stopPropagation();
                          // 셀 아무 데나 눌러도 토글 (체크박스 자체 클릭은 기본 동작)
                          if ((e.target as HTMLElement).tagName !== "INPUT") toggleSelectOne(o.id);
                        }}
                        style={{ padding: "8px", cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          className="b2b-checkbox"
                          checked={selected.has(o.id)}
                          onChange={() => toggleSelectOne(o.id)}
                        />
                      </td>
                      <td className="cell-flag" style={{ padding: "8px 4px" }}>
                        {complete ? (
                          <span className="b2b-urgency-pill is-complete">완료</span>
                        ) : urgency !== "normal" ? (
                          <span className={`b2b-urgency-pill is-${urgency}`}>
                            {URGENCY_LABEL[urgency]}
                          </span>
                        ) : null}
                      </td>
                      <RowCell href={`/b2b/orders/${o.id}`} nowrap>
                        <span>{o.company_name}</span>
                        <span style={{ display: "block", fontSize: 11, color: "var(--sm-text-light)", marginTop: 2 }}>
                          {o.order_no}{parent ? " · 복수발송" : ""}
                        </span>
                      </RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`}>
                        <ItemsPreview items={o.items} />
                      </RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`} className="b2b-col-date" nowrap>{o.order_date}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`} className="b2b-col-date" nowrap>{o.production_date || (!parent ? o.ship_date : "") || "-"}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`} className="b2b-col-date" nowrap>{parent ? "" : (o.ship_date || "-")}</RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`} className="num b2b-money">
                        {formatMoney(o.total)}
                      </RowCell>
                      <td onClick={(e) => e.stopPropagation()}>
                        {parent && prog ? (
                          <button
                            type="button"
                            className="b2b-parent-toggle"
                            onClick={() => toggleExpand(o.id)}
                            title="발송 차수 펼치기/접기"
                          >
                            발송 {prog.done}/{prog.total} <span style={{ fontSize: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
                          </button>
                        ) : (
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
                        )}
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
                      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                        <Link
                          href={`/b2b/orders/new?from=${o.id}`}
                          className="b2b-btn-secondary"
                          style={{ padding: "5px 10px", fontSize: 12 }}
                          title="이 발주를 복제해 새 발주 만들기"
                        >
                          복제
                        </Link>
                      </td>
                    </tr>
                    {parent && !isCollapsed && (o.shipments ?? []).map((s) => (
                      <tr key={s.id} className="b2b-child-row">
                        <td></td>
                        <td></td>
                        <td colSpan={10} style={{ padding: "8px 18px 8px 30px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <Link href={`/b2b/orders/${o.id}`} className="b2b-row-link" style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                              <span style={{ color: "var(--sm-text-light)", fontSize: 13 }}>└ {s.seq}차</span>
                              <span style={{ fontSize: 13 }}>{s.ship_date || "날짜 미정"}</span>
                              {s.items.length > 0 && (
                                <span style={{ fontSize: 12.5, color: "var(--sm-text-mid)" }}>
                                  {s.items.slice(0, 2).map((it) => `${it.product_name}${it.spec ? ` ${it.spec}` : ""} ×${formatQty(it.qty)}`).join(", ")}
                                  {s.items.length > 2 ? ` 외 ${s.items.length - 2}종` : ""}
                                </span>
                              )}
                            </Link>
                            <select
                              className="b2b-status-select"
                              value={s.status}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => handleShipmentStatus(o, s, e.target.value as ShipmentStatus)}
                              style={{ background: SHIPMENT_STATUS_COLORS[s.status]?.bg, color: SHIPMENT_STATUS_COLORS[s.status]?.fg }}
                              title="이 차수의 상태 변경"
                            >
                              {SHIPMENT_STATUSES.map((st) => (
                                <option key={st} value={st}>{STATUS_SHORT[st] || st}</option>
                              ))}
                            </select>
                          </div>
                        </td>
                      </tr>
                    ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>

            {/* 모바일 카드 뷰 */}
            <div className="b2b-order-cards">
              {filtered.map((o) => {
                const urgency = getUrgency({ ...o, ship_date: nextPendingShipDate(o) }, today);
                const parent = isParentOrder(o);
                const prog = parent ? shipProgress(o) : null;
                const isCollapsed = !expanded.has(o.id); // 기본 접힘
                const complete = isOrderComplete(o);
                return (
                  <div key={o.id} className={`b2b-order-card ${urgency !== "normal" ? `is-${urgency}` : ""}`}>
                    <div className="b2b-order-card-check">
                      <input
                        type="checkbox"
                        className="b2b-checkbox"
                        checked={selected.has(o.id)}
                        onChange={() => toggleSelectOne(o.id)}
                      />
                    </div>
                    <Link href={`/b2b/orders/${o.id}`} className="b2b-order-card-body">
                      <div className="b2b-order-card-top">
                        <div>
                          <div className="b2b-order-card-company">{o.company_name}</div>
                          <div className="b2b-order-card-no">{o.order_no}</div>
                        </div>
                        {complete ? (
                          <span className="b2b-urgency-pill is-complete">완료</span>
                        ) : urgency !== "normal" ? (
                          <span className={`b2b-urgency-pill is-${urgency}`}>{URGENCY_LABEL[urgency]}</span>
                        ) : null}
                      </div>
                      <div className="b2b-order-card-items">
                        <ItemsPreview items={o.items} />
                      </div>
                      <div className="b2b-order-card-dates">
                        <span><em>발주</em>{o.order_date?.slice(5) || "-"}</span>
                        <span><em>생산</em>{(o.production_date || (!parent ? o.ship_date : ""))?.slice(5) || "-"}</span>
                        {!parent && <span><em>발송</em>{o.ship_date?.slice(5) || "-"}</span>}
                      </div>
                      <div className="b2b-order-card-foot">
                        <span className="b2b-order-card-total">{formatMoney(o.total)}원</span>
                        <div className="b2b-order-card-pills">
                          {parent && prog ? (
                            <span
                              className="b2b-status-pill"
                              role="button"
                              tabIndex={0}
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(o.id); }}
                              style={{ background: "#EEF2F6", color: "#475569", cursor: "pointer" }}
                              title="발송 차수 펼치기/접기"
                            >
                              발송 {prog.done}/{prog.total} <span style={{ fontSize: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
                            </span>
                          ) : (
                            <span className="b2b-status-pill" style={{ background: STATUS_COLORS[o.status]?.bg, color: STATUS_COLORS[o.status]?.fg }}>
                              {STATUS_SHORT[o.status] || o.status}
                            </span>
                          )}
                          <span className="b2b-status-pill" style={{ background: PAYMENT_COLORS[o.payment_status]?.bg, color: PAYMENT_COLORS[o.payment_status]?.fg }}>
                            {o.payment_status}
                          </span>
                        </div>
                      </div>
                    </Link>
                    {parent && !isCollapsed && (
                      <div className="b2b-order-card-children">
                        {(o.shipments ?? []).map((s) => (
                          <div key={s.id} className="b2b-order-card-child">
                            <span style={{ color: "var(--sm-text-light)", fontSize: 12.5, whiteSpace: "nowrap" }}>└ {s.seq}차</span>
                            <span style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{s.ship_date?.slice(5) || "날짜미정"}</span>
                            {s.items.length > 0 && (
                              <span style={{ fontSize: 12, color: "var(--sm-text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                                {s.items.map((it) => `${it.product_name}${it.spec ? ` ${it.spec}` : ""}×${formatQty(it.qty)}`).join(", ")}
                              </span>
                            )}
                            <select
                              className="b2b-status-select"
                              value={s.status}
                              onChange={(e) => handleShipmentStatus(o, s, e.target.value as ShipmentStatus)}
                              style={{ background: SHIPMENT_STATUS_COLORS[s.status]?.bg, color: SHIPMENT_STATUS_COLORS[s.status]?.fg, marginLeft: "auto", flexShrink: 0 }}
                            >
                              {SHIPMENT_STATUSES.map((st) => (
                                <option key={st} value={st}>{STATUS_SHORT[st] || st}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      )}

      {exportOptions && (
        <ExportPickModal
          options={exportOptions}
          exporting={exporting}
          onClose={() => setExportOptions(null)}
          onConfirm={(payload) => downloadShipping(payload)}
        />
      )}

      {trackingPrompt && (
        <div className="b2b-modal-backdrop" onClick={() => setTrackingPrompt(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">발송완료 — 송장번호 입력</h2>
              <button className="b2b-modal-close" onClick={() => setTrackingPrompt(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div style={{ fontSize: 13, color: "var(--sm-text-mid)", marginBottom: 10 }}>
                <strong>{trackingPrompt.label}</strong> 을(를) 발송완료 처리합니다.{" "}
                {directDelivery
                  ? "직접 배송 — 송장번호 없이 처리됩니다."
                  : trackingPrompt.boxCount > 1
                  ? `${trackingPrompt.boxCount}박스 — 박스별 송장번호를 모두 입력하세요.`
                  : "송장번호를 입력하세요."}
              </div>

              {/* 직접 배송(택배 아님): 체크 시 송장번호 불필요 */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, marginBottom: directDelivery ? 0 : 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  className="b2b-checkbox"
                  checked={directDelivery}
                  onChange={(e) => setDirectDelivery(e.target.checked)}
                />
                직접 배송 (송장번호 없음)
              </label>

              {!directDelivery && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {trackingInput.map((tn, bi) => (
                    <input
                      key={bi}
                      type="text"
                      className="b2b-input"
                      value={tn}
                      onChange={(e) =>
                        setTrackingInput((prev) => prev.map((v, i) => (i === bi ? e.target.value : v)))
                      }
                      placeholder={trackingPrompt.boxCount > 1 ? `박스 ${bi + 1} 송장번호` : "송장번호"}
                      autoFocus={bi === 0}
                      onKeyDown={(e) => { if (e.key === "Enter" && trackingComplete) confirmTracking(); }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setTrackingPrompt(null)}>취소</button>
                <button className="b2b-btn-primary" onClick={confirmTracking} disabled={!trackingComplete}>
                  발송완료 처리
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// 엑셀 필터식 체크박스 다중선택 드롭다운 (체크된 항목만 표시)
// ─────────────────────────────────────────────
function CheckFilter<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly T[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const all = options.every((o) => selected.has(o));
  const summary = all ? "전체" : selected.size === 0 ? "없음" : `${selected.size}개`;

  function toggle(o: T) {
    const next = new Set(selected);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    onChange(next);
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="b2b-select"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "auto", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, color: all ? "var(--sm-text-mid)" : "var(--sm-dark)", fontWeight: all ? 400 : 600 }}
        title={`${label} 필터`}
      >
        {label}: {summary} ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
            minWidth: 180,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--sm-white)",
            border: "1px solid var(--sm-border)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: 6,
          }}
        >
          <label className="b2b-checkfilter-row" style={{ fontWeight: 700 }}>
            <input
              type="checkbox"
              className="b2b-checkbox"
              checked={all}
              onChange={() => onChange(all ? new Set() : new Set(options))}
            />
            전체 선택
          </label>
          <div style={{ height: 1, background: "var(--sm-border)", margin: "4px 0" }} />
          {options.map((o) => (
            <label key={o} className="b2b-checkfilter-row">
              <input type="checkbox" className="b2b-checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
              {o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 발송 일정 선택 모달 — 분할 발송이 있는 발주에서 "어떤 발송을 뽑을지" 선택
// ─────────────────────────────────────────────
function shipmentSummary(s: ShipmentExportOption, fallback: ExportLineItem[]): string {
  const list = s.items.length > 0 ? s.items : fallback;
  if (list.length === 0) return "(상품 없음)";
  const label = (it: ExportLineItem) =>
    `${it.product_name}${it.spec ? ` ${it.spec}` : ""} ×${formatQty(it.qty)}`;
  const head = list.slice(0, 2).map(label).join(", ");
  const rest = list.length - Math.min(2, list.length);
  const base = rest > 0 ? `${head} 외 ${rest}종` : head;
  return s.items.length === 0 ? `${base} · 전체상품` : base;
}

function ExportPickModal({
  options,
  exporting,
  onClose,
  onConfirm,
}: {
  options: OrderExportOption[];
  exporting: boolean;
  onClose: () => void;
  onConfirm: (payload: { shipment_ids: string[]; order_ids: string[] }) => void;
}) {
  // 기본 선택: 취소가 아닌 모든 발송 + 발송 없는 발주(전체)
  const [shipSel, setShipSel] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const o of options) for (const sh of o.shipments) if (sh.status !== "취소") s.add(sh.id);
    return s;
  });
  const [orderSel, setOrderSel] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const o of options) if (o.shipments.length === 0) s.add(o.order_id);
    return s;
  });

  const totalSelected = shipSel.size + orderSel.size;

  function toggleShip(id: string) {
    setShipSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleOrder(id: string) {
    setOrderSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="b2b-modal-head">
          <div>
            <h2 className="b2b-modal-title">발송요청 양식 — 어떤 발송을 뽑을까요?</h2>
            <div style={{ marginTop: 4, fontSize: 13, color: "var(--sm-text-mid)" }}>
              분할 발송이 있어요. 출력할 발송 일정을 선택하세요.
            </div>
          </div>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {options.map((o) => (
            <div
              key={o.order_id}
              style={{ border: "1px solid var(--sm-border)", borderRadius: 10, overflow: "hidden" }}
            >
              <div
                style={{
                  padding: "9px 12px",
                  background: "var(--sm-bg)",
                  fontSize: 13,
                  fontWeight: 700,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span>{o.company_name}</span>
                <span style={{ color: "var(--sm-text-light)", fontWeight: 500 }}>{o.order_no}</span>
              </div>

              {o.shipments.length === 0 ? (
                <label className="b2b-export-pick">
                  <input
                    type="checkbox"
                    className="b2b-checkbox"
                    checked={orderSel.has(o.order_id)}
                    onChange={() => toggleOrder(o.order_id)}
                  />
                  <span className="b2b-export-pick-main">
                    <span className="b2b-export-pick-date">발송일정 없음 · 전체</span>
                    <span className="b2b-export-pick-items">
                      {o.fallbackItems.length === 0
                        ? "(상품 없음)"
                        : o.fallbackItems
                            .slice(0, 2)
                            .map((it) => `${it.product_name}${it.spec ? ` ${it.spec}` : ""} ×${formatQty(it.qty)}`)
                            .join(", ") + (o.fallbackItems.length > 2 ? ` 외 ${o.fallbackItems.length - 2}종` : "")}
                    </span>
                  </span>
                </label>
              ) : (
                o.shipments.map((s) => {
                  const c = SHIPMENT_STATUS_COLORS[s.status];
                  return (
                    <label key={s.id} className="b2b-export-pick">
                      <input
                        type="checkbox"
                        className="b2b-checkbox"
                        checked={shipSel.has(s.id)}
                        onChange={() => toggleShip(s.id)}
                      />
                      <span className="b2b-export-pick-main">
                        <span className="b2b-export-pick-date">
                          {s.ship_date || "예정일 미정"}
                          <span
                            className="b2b-status-pill"
                            style={{ background: c?.bg, color: c?.fg, marginLeft: 8 }}
                          >
                            {s.status}
                          </span>
                        </span>
                        <span className="b2b-export-pick-items">{shipmentSummary(s, o.fallbackItems)}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          ))}
        </div>

        <div className="b2b-modal-foot">
          <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>
            <strong>{totalSelected}건</strong> 발송 선택됨
          </span>
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose}>
              취소
            </button>
            <button
              type="button"
              className="b2b-btn-primary"
              disabled={exporting || totalSelected === 0}
              onClick={() =>
                onConfirm({ shipment_ids: Array.from(shipSel), order_ids: Array.from(orderSel) })
              }
            >
              {exporting ? "생성 중..." : "선택 발송 양식 다운로드"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 복수 발송(발송 일정 2건 이상) = 상위발주. 상태는 표시하지 않고 하위 차수가 각자 가짐.
function isParentOrder(o: OrderListItem): boolean {
  return (o.shipments?.length ?? 0) >= 2;
}
// 상위발주 발송 진행도: 발송완료 / 전체(취소 제외)
function shipProgress(o: OrderListItem): { done: number; total: number } {
  const ships = (o.shipments ?? []).filter((s) => s.status !== "취소");
  return { done: ships.filter((s) => s.status === "발송완료").length, total: ships.length };
}

// 품목 미리보기 — 발주 상품을 "품목명 옵션 ×수량" 으로 나열, 많으면 외 N
function ItemsPreview({ items }: { items: OrderLinePreview[] }) {
  if (!items || items.length === 0) {
    return <span style={{ color: "var(--sm-text-light)" }}>-</span>;
  }
  const MAX = 3;
  const shown = items.slice(0, MAX);
  const rest = items.length - shown.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, lineHeight: 1.45 }}>
      {shown.map((it, i) => (
        <span key={i} style={{ whiteSpace: "nowrap" }}>
          {it.product_name}
          {it.spec ? <span style={{ color: "var(--sm-text-light)" }}> · {it.spec}</span> : ""}
          <span style={{ color: "var(--sm-text-mid)" }}> ×{it.qty}</span>
        </span>
      ))}
      {rest > 0 && (
        <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>외 {rest}종</span>
      )}
    </div>
  );
}

// 셀 안의 <a> 가 전체 셀 영역 클릭되도록 — display:block + 셀 padding 0
function RowCell({
  href,
  className,
  nowrap,
  children,
}: {
  href: string;
  className?: string;
  nowrap?: boolean;
  children: React.ReactNode;
}) {
  return (
    <td className={className} style={{ padding: 0 }}>
      <Link
        href={href}
        className="b2b-row-link"
        style={{ display: "block", padding: "15px 18px", whiteSpace: nowrap ? "nowrap" : undefined }}
      >
        {children}
      </Link>
    </td>
  );
}
