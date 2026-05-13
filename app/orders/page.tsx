"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Order,
  OrderInput,
  ORDER_STATUSES,
  EMPTY_ORDER,
  STATUS_COLORS,
  STATUS_SHORT,
  DateKind,
  DATE_KIND_LABEL,
  DATE_KIND_COLOR,
  WeekGroup,
  ProductGroup,
  URGENCY_LABEL,
  groupByWeek,
  groupByProduct,
  getUrgency,
  addDaysISO,
  formatNumber,
  formatSpec,
  formatWeight,
} from "@/app/lib/orders";

type View = "calendar" | "list" | "production" | "weekly";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("calendar");
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [modal, setModal] = useState<{ mode: "create" | "edit"; data: OrderInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"전체" | (typeof ORDER_STATUSES)[number]>("전체");

  const todayIso = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/orders", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "조회 실패");
      setOrders(data.orders || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  const filteredOrders = useMemo(() => {
    if (statusFilter === "전체") return orders;
    return orders.filter((o) => o.status === statusFilter);
  }, [orders, statusFilter]);

  const knownClients = useMemo(
    () => Array.from(new Set(orders.map((o) => o.client).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko")),
    [orders]
  );

  const knownProducts = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.product).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b, "ko")
      ),
    [orders]
  );

  async function handleSave() {
    if (!modal) return;
    setSaving(true);
    setError("");
    try {
      const method = modal.mode === "create" ? "POST" : "PUT";
      const res = await fetch("/api/orders", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modal.data),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "저장 실패");

      // 로컬 state 직접 업데이트 — 전체 reload 안 함
      if (modal.mode === "create") {
        const newOrder: Order = { ...(modal.data as Order), id: data.id };
        setOrders((prev) => [...prev, newOrder]);
      } else if (modal.data.id) {
        const updated: Order = modal.data as Order;
        setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      }
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 중 오류");
    }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!confirm("정말 삭제하시겠어요?")) return;
    setError("");

    // Optimistic: 즉시 UI 에서 제거
    const snapshot = orders;
    setOrders((prev) => prev.filter((o) => o.id !== id));

    try {
      const res = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setOrders(snapshot); // 롤백
        throw new Error(data.error || "삭제 실패");
      }
    } catch (err) {
      setOrders(snapshot); // 롤백
      setError(err instanceof Error ? err.message : "삭제 중 오류");
    }
  }

  // 인라인 상태 변경 — 즉시 UI 업데이트 + 백그라운드로 PUT
  async function handleStatusChange(orderId: string, newStatus: Order["status"]) {
    const target = orders.find((o) => o.id === orderId);
    if (!target || target.status === newStatus) return;

    const updated: Order = { ...target, status: newStatus };
    const snapshot = orders;

    // Optimistic update
    setOrders((prev) => prev.map((o) => (o.id === orderId ? updated : o)));

    try {
      const res = await fetch("/api/orders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!res.ok) {
        const data = await res.json();
        setOrders(snapshot); // 롤백
        setError(data.error || "상태 변경 실패");
      }
    } catch (err) {
      setOrders(snapshot); // 롤백
      setError(err instanceof Error ? err.message : "상태 변경 오류");
    }
  }

  return (
    <div className="orders-container">
      <div className="orders-header">
        <div>
          <h1 className="page-title">도매 발주 관리</h1>
          <p className="page-subtitle">발주·생산·발송 일정과 발주목록을 한곳에서 관리합니다.</p>
        </div>
        <div className="orders-header-actions">
          <button
            className="btn-secondary"
            onClick={reload}
            disabled={loading}
            title="시트에서 다시 불러오기"
          >
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <button className="btn-primary" onClick={() => setModal({ mode: "create", data: { ...EMPTY_ORDER } })}>
            + 새 발주 등록
          </button>
        </div>
      </div>

      <FocusBanner
        orders={orders}
        todayIso={todayIso}
        onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
      />

      <div className="orders-toolbar">
        <div className="orders-tabs">
          <button
            className={`orders-tab ${view === "calendar" ? "is-active" : ""}`}
            onClick={() => setView("calendar")}
          >
            캘린더
          </button>
          <button
            className={`orders-tab ${view === "list" ? "is-active" : ""}`}
            onClick={() => setView("list")}
          >
            발주목록
          </button>
          <button
            className={`orders-tab ${view === "production" ? "is-active" : ""}`}
            onClick={() => setView("production")}
          >
            생산 현황
          </button>
          <button
            className={`orders-tab ${view === "weekly" ? "is-active" : ""}`}
            onClick={() => setView("weekly")}
          >
            주간 (발송일)
          </button>
        </div>

        {view !== "production" && (
          <div className="orders-filter">
            <label className="orders-filter-label">상태</label>
            <select
              className="orders-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="전체">전체</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && <div className="orders-error">{error}</div>}

      {loading ? (
        <div className="loading-overlay">
          <div className="spinner" />
          <p className="loading-text">발주 데이터를 불러오는 중...</p>
        </div>
      ) : view === "calendar" ? (
        <CalendarView
          orders={filteredOrders}
          cursor={cursor}
          setCursor={setCursor}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
          todayIso={todayIso}
        />
      ) : view === "list" ? (
        <ListView
          orders={filteredOrders}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
          onDelete={handleDelete}
          onStatusChange={handleStatusChange}
          todayIso={todayIso}
        />
      ) : view === "production" ? (
        <ProductionView
          orders={orders}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
          todayIso={todayIso}
        />
      ) : (
        <WeeklyView
          orders={filteredOrders}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
          todayIso={todayIso}
        />
      )}

      {modal && (
        <OrderModal
          mode={modal.mode}
          data={modal.data}
          saving={saving}
          clientSuggestions={knownClients}
          productSuggestions={knownProducts}
          onChange={(data) => setModal({ ...modal, data })}
          onSave={handleSave}
          onClose={() => setModal(null)}
          onDelete={
            modal.mode === "edit" && modal.data.id
              ? () => {
                  if (modal.data.id) {
                    handleDelete(modal.data.id);
                    setModal(null);
                  }
                }
              : undefined
          }
          onClone={
            modal.mode === "edit"
              ? () => {
                  setModal({
                    mode: "create",
                    data: {
                      ...modal.data,
                      id: undefined,
                      orderDate: "",
                      productionDate: "",
                      shipDate: "",
                      status: "발주확인/생산대기",
                    },
                  });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 오늘/내일 집중 배너
// ─────────────────────────────────────────────
type FocusItem = { order: Order; kinds: DateKind[] };

function FocusBanner({
  orders,
  todayIso,
  onEdit,
}: {
  orders: Order[];
  todayIso: string;
  onEdit: (o: Order) => void;
}) {
  const tomorrowIso = useMemo(() => addDaysISO(todayIso, 1), [todayIso]);
  const [expanded, setExpanded] = useState(true);

  const buckets = useMemo(() => {
    const overdue: Order[] = [];
    const today: FocusItem[] = [];
    const tomorrow: FocusItem[] = [];

    for (const o of orders) {
      if (getUrgency(o, todayIso) === "overdue") {
        overdue.push(o);
        continue; // 지연이면 오늘/내일에서 제외 (중복 방지)
      }
      if (o.status === "발송완료") continue;

      const todayKinds: DateKind[] = [];
      if (o.orderDate === todayIso) todayKinds.push("order");
      if (o.productionDate === todayIso) todayKinds.push("production");
      if (o.shipDate === todayIso) todayKinds.push("ship");
      if (todayKinds.length > 0) today.push({ order: o, kinds: todayKinds });

      const tomorrowKinds: DateKind[] = [];
      if (o.orderDate === tomorrowIso) tomorrowKinds.push("order");
      if (o.productionDate === tomorrowIso) tomorrowKinds.push("production");
      if (o.shipDate === tomorrowIso) tomorrowKinds.push("ship");
      if (tomorrowKinds.length > 0) tomorrow.push({ order: o, kinds: tomorrowKinds });
    }

    return { overdue, today, tomorrow };
  }, [orders, todayIso, tomorrowIso]);

  const total = buckets.overdue.length + buckets.today.length + buckets.tomorrow.length;
  if (total === 0) return null;

  return (
    <section className="focus-banner">
      <button
        type="button"
        className="focus-banner-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="focus-pills">
          {buckets.overdue.length > 0 && (
            <span className="focus-pill is-overdue">
              <span className="focus-pill-dot" aria-hidden />지연 {buckets.overdue.length}건
            </span>
          )}
          <span className={`focus-pill ${buckets.today.length > 0 ? "is-today" : "is-zero"}`}>
            <span className="focus-pill-dot" aria-hidden />오늘 {buckets.today.length}건
          </span>
          <span className={`focus-pill ${buckets.tomorrow.length > 0 ? "is-tomorrow" : "is-zero"}`}>
            <span className="focus-pill-dot" aria-hidden />내일 {buckets.tomorrow.length}건
          </span>
        </div>
        <span className="focus-toggle">{expanded ? "접기 ▲" : "펼치기 ▼"}</span>
      </button>

      {expanded && (
        <div className="focus-banner-body">
          {buckets.overdue.length > 0 && (
            <FocusGroup
              title="지연"
              tone="overdue"
              items={buckets.overdue.map((o) => ({ order: o, kinds: [] }))}
              onEdit={onEdit}
            />
          )}
          {buckets.today.length > 0 && (
            <FocusGroup title="오늘" tone="today" items={buckets.today} onEdit={onEdit} />
          )}
          {buckets.tomorrow.length > 0 && (
            <FocusGroup title="내일" tone="tomorrow" items={buckets.tomorrow} onEdit={onEdit} />
          )}
        </div>
      )}
    </section>
  );
}

function FocusGroup({
  title,
  tone,
  items,
  onEdit,
}: {
  title: string;
  tone: "overdue" | "today" | "tomorrow";
  items: FocusItem[];
  onEdit: (o: Order) => void;
}) {
  return (
    <div className={`focus-group is-${tone}`}>
      <h3 className="focus-group-title">
        {title} <span className="focus-group-count">({items.length})</span>
      </h3>
      <div className="focus-group-list">
        {items.map(({ order: o, kinds }) => (
          <button key={o.id} type="button" className="focus-row" onClick={() => onEdit(o)}>
            <span className="focus-row-kinds">
              {kinds.length > 0 ? (
                kinds.map((k) => (
                  <span
                    key={k}
                    className="focus-row-kind"
                    style={{ background: DATE_KIND_COLOR[k] }}
                  >
                    {DATE_KIND_LABEL[k]}
                  </span>
                ))
              ) : (
                <span className="focus-row-kind is-overdue-kind">
                  지연
                  {(o.shipDate || o.productionDate || o.orderDate) && (
                    <span className="focus-row-kind-date">
                      {" "}· {(o.shipDate || o.productionDate || o.orderDate).slice(5)}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span className="focus-row-client">
              {o.client || "거래처 미정"}
              {o.note && <span className="note-marker" title={o.note}> 📝</span>}
            </span>
            <span className="focus-row-product">
              {o.product || "-"}{o.spec ? ` · ${formatSpec(o.spec)}` : ""}
            </span>
            <span className="focus-row-meta">
              {o.weight ? formatWeight(o.weight) : ""}{o.quantity ? ` × ${o.quantity}` : ""}
            </span>
            <span
              className="orders-status-pill"
              style={{
                background: STATUS_COLORS[o.status]?.bg,
                color: STATUS_COLORS[o.status]?.fg,
              }}
              title={o.status}
            >
              {STATUS_SHORT[o.status] || o.status}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 캘린더 뷰
// ─────────────────────────────────────────────
function CalendarView({
  orders,
  cursor,
  setCursor,
  onEdit,
  todayIso,
}: {
  orders: Order[];
  cursor: Date;
  setCursor: (d: Date) => void;
  onEdit: (o: Order) => void;
  todayIso: string;
}) {
  const isMobile = useIsMobile();
  const [weekStart, setWeekStart] = useState<Date>(() => weekStartOf(new Date()));
  const [visibleKinds, setVisibleKinds] = useState<Record<DateKind, boolean>>({
    order: true,
    production: true,
    ship: true,
  });
  const [showProgress, setShowProgress] = useState(true);

  function toggleKind(k: DateKind) {
    setVisibleKinds((prev) => ({ ...prev, [k]: !prev[k] }));
  }

  // 모바일: 지난주·이번주·다음주 3주(21셀) / 데스크탑: 한 달
  const navLabel = useMemo(() => {
    if (isMobile) {
      const start = addDaysDate(weekStart, -7);
      const end = addDaysDate(weekStart, 13);
      const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
      return `${fmt(start)} ~ ${fmt(end)}`;
    }
    return `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
  }, [isMobile, weekStart, cursor]);

  const cells = useMemo(() => {
    const result: { date: Date | null; iso: string; entries: { kind: DateKind; order: Order }[] }[] = [];

    if (isMobile) {
      // 지난주 월요일부터 21일치
      const start = addDaysDate(weekStart, -7);
      for (let i = 0; i < 21; i++) {
        const date = addDaysDate(start, i);
        const iso = toISO(date);
        const entries: { kind: DateKind; order: Order }[] = [];
        for (const o of orders) {
          if (visibleKinds.order && o.orderDate === iso) entries.push({ kind: "order", order: o });
          if (visibleKinds.production && o.productionDate === iso) entries.push({ kind: "production", order: o });
          if (visibleKinds.ship && o.shipDate === iso) entries.push({ kind: "ship", order: o });
        }
        result.push({ date, iso, entries });
      }
      return result;
    }

    // 데스크탑: 한 달
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startWeekday = first.getDay(); // 0=일
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

    // 일요일 시작이라 월요일 시작 주(週) packing과 어긋남 — 그대로 두되 첫 셀이 일요일 빈 칸으로 시작
    for (let i = 0; i < startWeekday; i++) result.push({ date: null, iso: "", entries: [] });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), d);
      const iso = toISO(date);
      const entries: { kind: DateKind; order: Order }[] = [];
      for (const o of orders) {
        if (visibleKinds.order && o.orderDate === iso) entries.push({ kind: "order", order: o });
        if (visibleKinds.production && o.productionDate === iso) entries.push({ kind: "production", order: o });
        if (visibleKinds.ship && o.shipDate === iso) entries.push({ kind: "ship", order: o });
      }
      result.push({ date, iso, entries });
    }
    // 마지막 주 빈 셀
    while (result.length % 7 !== 0) result.push({ date: null, iso: "", entries: [] });
    return result;
  }, [isMobile, weekStart, cursor, orders, visibleKinds]);

  // 발주일 → 생산일 구간을 주(週) 단위로 슬롯 패킹.
  // 같은 주 내에서 한 발주는 같은 슬롯에 머물러 가로로 이어지는 Gantt 바처럼 보이게 함.
  type CellSlot = { order: Order; isStart: boolean; isEnd: boolean } | null;
  const progressByIso = useMemo<Record<string, CellSlot[]>>(() => {
    if (!showProgress) return {};
    const result: Record<string, CellSlot[]> = {};
    // 7개씩 끊어 주(週) row 단위로 처리
    for (let i = 0; i < cells.length; i += 7) {
      const week = cells.slice(i, i + 7).filter((c) => c.iso);
      if (week.length === 0) continue;
      const weekFirst = week[0].iso;
      const weekLast = week[week.length - 1].iso;

      // 발주일·생산일 모두 있고 이번 주와 겹치는 발주만 추출
      const spans = orders
        .filter(
          (o) =>
            o.orderDate &&
            o.productionDate &&
            o.orderDate <= o.productionDate &&
            o.orderDate <= weekLast &&
            o.productionDate >= weekFirst
        )
        .map((o) => ({
          order: o,
          clipStart: o.orderDate < weekFirst ? weekFirst : o.orderDate,
          clipEnd: o.productionDate > weekLast ? weekLast : o.productionDate,
        }))
        .sort(
          (a, b) =>
            a.clipStart.localeCompare(b.clipStart) ||
            a.clipEnd.localeCompare(b.clipEnd) ||
            a.order.id.localeCompare(b.order.id)
        );

      // 그리디 슬롯 패킹: 끝난 슬롯을 재사용
      const slotEnds: string[] = [];
      const assignments: { span: typeof spans[number]; slot: number }[] = [];
      for (const span of spans) {
        let slot = slotEnds.findIndex((end) => end < span.clipStart);
        if (slot === -1) {
          slot = slotEnds.length;
          slotEnds.push(span.clipEnd);
        } else {
          slotEnds[slot] = span.clipEnd;
        }
        assignments.push({ span, slot });
      }

      const maxSlots = slotEnds.length;
      for (const cell of week) {
        const slots: CellSlot[] = new Array(maxSlots).fill(null);
        for (const { span, slot } of assignments) {
          if (cell.iso >= span.clipStart && cell.iso <= span.clipEnd) {
            slots[slot] = {
              order: span.order,
              isStart: cell.iso === span.order.orderDate,
              isEnd: cell.iso === span.order.productionDate,
            };
          }
        }
        result[cell.iso] = slots;
      }
    }
    return result;
  }, [cells, orders, showProgress]);

  return (
    <div>
      <div className="cal-nav">
        <button
          className="btn-secondary"
          onClick={() => {
            if (isMobile) setWeekStart((prev) => addDaysDate(prev, -7));
            else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
          }}
        >
          ←
        </button>
        <div className="cal-month">{navLabel}</div>
        <button
          className="btn-secondary"
          onClick={() => {
            if (isMobile) setWeekStart((prev) => addDaysDate(prev, 7));
            else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
          }}
        >
          →
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            const d = new Date();
            if (isMobile) setWeekStart(weekStartOf(d));
            else setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          오늘
        </button>
      </div>

      <div className="cal-legend">
        <span className="cal-legend-hint">표시:</span>
        {(Object.keys(DATE_KIND_LABEL) as DateKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`cal-legend-item ${visibleKinds[k] ? "is-active" : "is-inactive"}`}
            onClick={() => toggleKind(k)}
            aria-pressed={visibleKinds[k]}
            title={`${DATE_KIND_LABEL[k]}일 ${visibleKinds[k] ? "숨기기" : "보이기"}`}
          >
            <span className="cal-legend-dot" style={{ background: DATE_KIND_COLOR[k] }} />
            {DATE_KIND_LABEL[k]}일
          </button>
        ))}
        <button
          type="button"
          className={`cal-legend-item ${showProgress ? "is-active" : "is-inactive"}`}
          onClick={() => setShowProgress((v) => !v)}
          aria-pressed={showProgress}
          title={`발주→생산 진행 바 ${showProgress ? "숨기기" : "보이기"}`}
        >
          <span className="cal-legend-bar" />
          발주→생산 진행
        </button>
      </div>

      <div className={`cal-grid ${isMobile ? "is-mobile-3week" : ""}`}>
        {(isMobile
          ? ["월", "화", "수", "목", "금", "토", "일"]
          : ["일", "월", "화", "수", "목", "금", "토"]
        ).map((w) => (
          <div key={w} className="cal-weekday">
            {w}
          </div>
        ))}
        {cells.map((cell, i) => (
          <div
            key={i}
            className={`cal-cell ${cell.date ? "" : "is-empty"} ${cell.iso === todayIso ? "is-today" : ""}`}
          >
            {cell.date && (
              <>
                <div className="cal-date">{cell.date.getDate()}</div>
                {showProgress && progressByIso[cell.iso] && progressByIso[cell.iso].length > 0 && (
                  <div className="cal-spans">
                    {progressByIso[cell.iso].map((s, slotIdx) =>
                      s ? (
                        <button
                          key={slotIdx}
                          type="button"
                          className={`cal-span ${s.isStart ? "is-start" : ""} ${s.isEnd ? "is-end" : ""}`}
                          onClick={() => onEdit(s.order)}
                          style={{
                            background: STATUS_COLORS[s.order.status]?.fg,
                          }}
                          title={`${s.order.client || "-"} · ${s.order.product || "-"} (${s.order.orderDate} → ${s.order.productionDate})`}
                        >
                          <span className="cal-span-label">
                            {s.isStart
                              ? `${s.order.client || "거래처 미정"} · ${s.order.product || "품목 미정"}`
                              : " "}
                          </span>
                        </button>
                      ) : (
                        <span key={slotIdx} className="cal-span is-empty" aria-hidden />
                      )
                    )}
                  </div>
                )}
                <div className="cal-entries">
                  {cell.entries.map((e, idx) => {
                    const urgency = getUrgency(e.order, todayIso);
                    return (
                      <button
                        key={`${e.order.id}-${e.kind}-${idx}`}
                        className={`cal-entry ${urgency !== "normal" ? `is-${urgency}` : ""}`}
                        onClick={() => onEdit(e.order)}
                        style={{ borderLeftColor: DATE_KIND_COLOR[e.kind] }}
                        title={`${DATE_KIND_LABEL[e.kind]}일 · ${e.order.client} · ${e.order.product}${
                          urgency !== "normal" ? ` · ${URGENCY_LABEL[urgency]}` : ""
                        }${e.order.note ? `\n📝 ${e.order.note}` : ""}`}
                      >
                        <span className="cal-entry-kind" style={{ color: DATE_KIND_COLOR[e.kind] }}>
                          {DATE_KIND_LABEL[e.kind]}
                        </span>
                        <span className="cal-entry-text">
                          {e.order.client || "-"} · {e.order.product || "-"}
                        </span>
                        {e.order.note && <span className="cal-entry-note" aria-label="메모 있음">📝</span>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 리스트 뷰
// ─────────────────────────────────────────────
function ListView({
  orders,
  onEdit,
  onDelete,
  onStatusChange,
  todayIso,
}: {
  orders: Order[];
  onEdit: (o: Order) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: Order["status"]) => void;
  todayIso: string;
}) {
  const sorted = useMemo(() => {
    // 발송일 → 생산일 → 발주일 순서 우선, 빈 값은 뒤로
    return [...orders].sort((a, b) => {
      const ka = a.shipDate || a.productionDate || a.orderDate || "9999";
      const kb = b.shipDate || b.productionDate || b.orderDate || "9999";
      return ka.localeCompare(kb);
    });
  }, [orders]);

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📦</div>
        <div className="empty-state-text">등록된 발주가 없습니다.</div>
      </div>
    );
  }

  return (
    <>
      {/* 모바일 카드 뷰 */}
      <div className="orders-cards">
        {sorted.map((o) => {
          const urgency = getUrgency(o, todayIso);
          return (
            <button
              key={o.id}
              type="button"
              className={`order-card ${urgency !== "normal" ? `is-${urgency}` : ""}`}
              onClick={() => onEdit(o)}
            >
              <div className="order-card-top">
                <span className="order-card-client">
                  {o.client || "거래처 미정"}
                  {o.note && <span className="note-marker" title={o.note}> 📝</span>}
                </span>
                {urgency !== "normal" && (
                  <span className={`urgency-pill is-${urgency}`}>{URGENCY_LABEL[urgency]}</span>
                )}
              </div>
              <div className="order-card-product">
                {o.product || "품목 미정"}
                {o.spec ? <span className="order-card-spec"> · {formatSpec(o.spec)}</span> : ""}
              </div>
              <div className="order-card-meta">
                {o.weight ? formatWeight(o.weight) : ""}
                {o.weight && o.quantity ? " · " : ""}
                {o.quantity ? `${o.quantity}개` : ""}
                {!o.weight && !o.quantity ? "-" : ""}
              </div>
              <div className="order-card-dates">
                <span className="order-card-date"><em>발주</em>{o.orderDate ? o.orderDate.slice(5) : "-"}</span>
                <span className="order-card-date"><em>생산</em>{o.productionDate ? o.productionDate.slice(5) : "-"}</span>
                <span className="order-card-date"><em>발송</em>{o.shipDate ? o.shipDate.slice(5) : "-"}</span>
              </div>
              <div className="order-card-footer" onClick={(e) => e.stopPropagation()}>
                <select
                  className="status-select"
                  value={o.status}
                  onChange={(e) => onStatusChange(o.id, e.target.value as Order["status"])}
                  style={{
                    background: STATUS_COLORS[o.status]?.bg,
                    color: STATUS_COLORS[o.status]?.fg,
                  }}
                  title={o.status}
                >
                  {ORDER_STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_SHORT[s] || s}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="link-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(o.id);
                  }}
                >
                  삭제
                </button>
              </div>
            </button>
          );
        })}
      </div>

      {/* 데스크탑 테이블 뷰 */}
      <div className="orders-table-wrap">
        <table className="orders-table">
          <thead>
            <tr>
              <th></th>
              <th>발주일</th>
              <th>생산일</th>
              <th>발송일</th>
              <th>거래처</th>
              <th>품목</th>
              <th>규격 (g)</th>
              <th>중량 (kg)</th>
              <th>수량</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => {
              const urgency = getUrgency(o, todayIso);
              return (
                <tr
                  key={o.id}
                  onClick={() => onEdit(o)}
                  className={urgency !== "normal" ? `is-${urgency}` : ""}
                >
                  <td className="cell-flag">
                    {urgency !== "normal" && (
                      <span className={`urgency-pill is-${urgency}`} title={URGENCY_LABEL[urgency]}>
                        {URGENCY_LABEL[urgency]}
                      </span>
                    )}
                  </td>
                  <td className="cell-date">{o.orderDate || "-"}</td>
                  <td className="cell-date">{o.productionDate || "-"}</td>
                  <td className="cell-date">{o.shipDate || "-"}</td>
                  <td>{o.client || "-"}</td>
                  <td>
                    {o.product || "-"}
                    {o.note && <span className="note-marker" title={o.note}> 📝</span>}
                  </td>
                  <td>{formatSpec(o.spec) || "-"}</td>
                  <td>{formatWeight(o.weight) || "-"}</td>
                  <td>{o.quantity || "-"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="status-select"
                      value={o.status}
                      onChange={(e) => onStatusChange(o.id, e.target.value as Order["status"])}
                      style={{
                        background: STATUS_COLORS[o.status]?.bg,
                        color: STATUS_COLORS[o.status]?.fg,
                      }}
                      title={o.status}
                    >
                      {ORDER_STATUSES.map((s) => (
                        <option key={s} value={s}>{STATUS_SHORT[s] || s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="cell-actions">
                    <button
                      className="link-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(o.id);
                      }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// 생산 현황 뷰 (생산일 기준 주간별 표 형식)
// ─────────────────────────────────────────────
function ProductionView({
  orders,
  onEdit,
  todayIso,
}: {
  orders: Order[];
  onEdit: (o: Order) => void;
  todayIso: string;
}) {
  // 발송완료를 제외한 진행 중인 발주만 표시
  const active = useMemo(
    () => orders.filter((o) => o.status !== "발송완료"),
    [orders]
  );

  const weeks = useMemo(
    () =>
      groupByWeek(active, {
        dateKey: "productionDate",
      }),
    [active]
  );

  const todayMonday = useMemo(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const m = new Date(d);
    m.setDate(d.getDate() + diff);
    return toISOForView(m);
  }, []);

  if (active.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🏭</div>
        <div className="empty-state-text">계획 중이거나 생산 중인 발주가 없습니다.</div>
      </div>
    );
  }

  return (
    <div className="prod-wrap">
      <p className="prod-help">생산일 기준 · 대기/생산중인 발주만 표시됩니다.</p>
      {weeks.map((w) => (
        <ProductionWeekCard
          key={w.weekStart || "unscheduled"}
          week={w}
          isCurrent={w.weekStart === todayMonday}
          onEdit={onEdit}
          todayIso={todayIso}
        />
      ))}
    </div>
  );
}

function ProductionWeekCard({
  week,
  isCurrent,
  onEdit,
  todayIso,
}: {
  week: WeekGroup;
  isCurrent: boolean;
  onEdit: (o: Order) => void;
  todayIso: string;
}) {
  return (
    <section className={`week-card ${isCurrent ? "is-current" : ""} ${!week.weekStart ? "is-unscheduled" : ""}`}>
      <div className="week-card-header">
        <div className="week-card-title-block">
          <h2 className="week-card-title">{week.label}</h2>
          {isCurrent && <span className="week-card-badge">이번 주</span>}
        </div>
        <div className="week-card-totals">
          <div className="week-total">
            <span className="week-total-label">발주</span>
            <span className="week-total-value">{week.orders.length}건</span>
          </div>
          <div className="week-total">
            <span className="week-total-label">총 중량</span>
            <span className="week-total-value week-total-weight">
              {week.totalWeight ? `${formatNumber(week.totalWeight)}kg` : "-"}
            </span>
          </div>
          <div className="week-total">
            <span className="week-total-label">총 수량</span>
            <span className="week-total-value">{formatNumber(week.totalQuantity) || "-"}</span>
          </div>
        </div>
      </div>

      <div className="week-card-body">
        <ProductionSubSection
          title="생산 진행"
          accent="#0a66c2"
          orders={week.orders.filter(
            (o) => o.status === "발주확인/생산대기" || o.status === "생산요청/생산중"
          )}
        />
        <ProductionSubSection
          title="생산 완료"
          accent="#22863a"
          orders={week.orders.filter((o) => o.status === "생산완료/발송대기")}
        />

        <details className="week-orders-toggle">
          <summary>개별 발주 보기 ({week.orders.length}건)</summary>
          <div className="week-orders-list">
            {week.orders.map((o) => {
              const urgency = getUrgency(o, todayIso);
              return (
                <button
                  key={o.id}
                  className={`week-order-row ${urgency !== "normal" ? `is-${urgency}` : ""}`}
                  onClick={() => onEdit(o)}
                >
                  <span className="week-order-date">{o.productionDate || "-"}</span>
                  <span className="week-order-client">
                    {o.client || "거래처 미정"}
                    {o.note && <span className="note-marker" title={o.note}> 📝</span>}
                  </span>
                  <span className="week-order-product">
                    {o.product || "-"}{o.spec ? ` · ${formatSpec(o.spec)}` : ""}
                  </span>
                  <span className="week-order-meta">
                    {o.weight ? formatWeight(o.weight) : ""}{o.quantity ? ` × ${o.quantity}` : ""}
                  </span>
                  <span
                    className="orders-status-pill"
                    style={{
                      background: STATUS_COLORS[o.status]?.bg,
                      color: STATUS_COLORS[o.status]?.fg,
                    }}
                    title={o.status}
                  >
                    {STATUS_SHORT[o.status] || o.status}
                  </span>
                </button>
              );
            })}
          </div>
        </details>
      </div>
    </section>
  );
}

function ProductionSubSection({
  title,
  accent,
  orders,
}: {
  title: string;
  accent: string;
  orders: Order[];
}) {
  const groups = useMemo<ProductGroup[]>(() => groupByProduct(orders), [orders]);
  if (groups.length === 0) return null;

  const totalWeight = groups.reduce((sum, g) => sum + g.totalWeight, 0);
  const totalQuantity = groups.reduce((sum, g) => sum + g.totalQuantity, 0);

  return (
    <div className="prod-sub">
      <div className="prod-sub-header">
        <h3 className="prod-sub-title">
          <span className="prod-sub-dot" style={{ background: accent }} aria-hidden />
          {title}
        </h3>
        <span className="prod-sub-summary">
          {totalWeight ? `${formatNumber(totalWeight)}kg` : ""}
          {totalQuantity ? ` · ${formatNumber(totalQuantity)}개` : ""}
          {` · ${orders.length}건`}
        </span>
      </div>
      {/* 모바일 카드 뷰 */}
      <div className="week-cards">
        {groups.map((g) => (
          <div key={`${g.product}__${g.spec}__m`} className="week-card-item">
            <div className="week-card-item-product">
              <strong>{g.product}</strong>
              {g.spec ? <span className="week-card-item-spec"> · {formatSpec(g.spec)}</span> : ""}
            </div>
            <div className="week-card-item-totals">
              {g.totalWeight ? (
                <span><em>총 중량</em>{formatNumber(g.totalWeight)}kg</span>
              ) : null}
              {g.totalQuantity ? (
                <span><em>총 수량</em>{formatNumber(g.totalQuantity)}개</span>
              ) : null}
            </div>
            {g.clients.length > 0 && (
              <div className="week-card-item-clients">{g.clients.join(", ")}</div>
            )}
          </div>
        ))}
      </div>

      {/* 데스크탑 표 뷰 */}
      <div className="week-table-wrap">
        <table className="week-table">
          <thead>
            <tr>
              <th>품목</th>
              <th>규격</th>
              <th className="num">총 중량</th>
              <th className="num">총 수량</th>
              <th>거래처</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.product}__${g.spec}`}>
                <td className="week-table-product">{g.product}</td>
                <td>{g.spec ? formatSpec(g.spec) : "-"}</td>
                <td className="num">{g.totalWeight ? `${formatNumber(g.totalWeight)}kg` : "-"}</td>
                <td className="num">{formatNumber(g.totalQuantity) || "-"}</td>
                <td className="week-table-clients">
                  {g.clients.length > 0 ? g.clients.join(", ") : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 주간 뷰 (발송일 = 매출일 기준)
// ─────────────────────────────────────────────
function WeeklyView({
  orders,
  onEdit,
  todayIso,
}: {
  orders: Order[];
  onEdit: (o: Order) => void;
  todayIso: string;
}) {
  const weeks = useMemo(() => groupByWeek(orders), [orders]);
  const todayMonday = useMemo(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const m = new Date(d);
    m.setDate(d.getDate() + diff);
    return toISOForView(m);
  }, []);

  if (weeks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📅</div>
        <div className="empty-state-text">표시할 발주가 없습니다.</div>
      </div>
    );
  }

  return (
    <div className="week-wrap">
      {weeks.map((w) => (
        <WeekCard
          key={w.weekStart || "unscheduled"}
          week={w}
          isCurrent={w.weekStart === todayMonday}
          onEdit={onEdit}
          todayIso={todayIso}
        />
      ))}
    </div>
  );
}

function WeekCard({
  week,
  isCurrent,
  onEdit,
  todayIso,
}: {
  week: WeekGroup;
  isCurrent: boolean;
  onEdit: (o: Order) => void;
  todayIso: string;
}) {
  return (
    <section className={`week-card ${isCurrent ? "is-current" : ""} ${!week.weekStart ? "is-unscheduled" : ""}`}>
      <div className="week-card-header">
        <div className="week-card-title-block">
          <h2 className="week-card-title">{week.label}</h2>
          {isCurrent && <span className="week-card-badge">이번 주</span>}
        </div>
        <div className="week-card-totals">
          <div className="week-total">
            <span className="week-total-label">발주</span>
            <span className="week-total-value">{week.orders.length}건</span>
          </div>
          <div className="week-total">
            <span className="week-total-label">총 중량</span>
            <span className="week-total-value week-total-weight">
              {week.totalWeight ? `${formatNumber(week.totalWeight)}kg` : "-"}
            </span>
          </div>
          <div className="week-total">
            <span className="week-total-label">총 수량</span>
            <span className="week-total-value">{formatNumber(week.totalQuantity) || "-"}</span>
          </div>
        </div>
      </div>

      <div className="week-card-body">
        <ProductionSubSection
          title="발송 예정"
          accent="#F15A30"
          orders={week.orders.filter((o) => o.status !== "발송완료")}
        />
        <ProductionSubSection
          title="발송 완료"
          accent="#22863a"
          orders={week.orders.filter((o) => o.status === "발송완료")}
        />

        <details className="week-orders-toggle">
          <summary>개별 발주 보기 ({week.orders.length}건)</summary>
          <div className="week-orders-list">
            {week.orders.map((o) => {
              const urgency = getUrgency(o, todayIso);
              return (
                <button
                  key={o.id}
                  className={`week-order-row ${urgency !== "normal" ? `is-${urgency}` : ""}`}
                  onClick={() => onEdit(o)}
                >
                  <span className="week-order-date">{o.shipDate || "-"}</span>
                  <span className="week-order-client">
                    {o.client || "거래처 미정"}
                    {o.note && <span className="note-marker" title={o.note}> 📝</span>}
                  </span>
                  <span className="week-order-product">
                    {o.product || "-"}{o.spec ? ` · ${formatSpec(o.spec)}` : ""}
                  </span>
                  <span className="week-order-meta">
                    {o.weight ? formatWeight(o.weight) : ""}{o.quantity ? ` × ${o.quantity}` : ""}
                  </span>
                  <span
                    className="orders-status-pill"
                    style={{
                      background: STATUS_COLORS[o.status]?.bg,
                      color: STATUS_COLORS[o.status]?.fg,
                    }}
                    title={o.status}
                  >
                    {STATUS_SHORT[o.status] || o.status}
                  </span>
                </button>
              );
            })}
          </div>
        </details>
      </div>
    </section>
  );
}

function toISOForView(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────
// 등록/수정 모달
// ─────────────────────────────────────────────
function OrderModal({
  mode,
  data,
  saving,
  clientSuggestions = [],
  productSuggestions = [],
  onChange,
  onSave,
  onClose,
  onDelete,
  onClone,
}: {
  mode: "create" | "edit";
  data: OrderInput;
  saving: boolean;
  clientSuggestions?: string[];
  productSuggestions?: string[];
  onChange: (d: OrderInput) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onClone?: () => void;
}) {
  function set<K extends keyof OrderInput>(key: K, value: OrderInput[K]) {
    onChange({ ...data, [key]: value });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{mode === "create" ? "새 발주 등록" : "발주 수정"}</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <Field label="발주일">
              <input
                type="date"
                className="orders-input"
                value={data.orderDate}
                onChange={(e) => set("orderDate", e.target.value)}
              />
            </Field>
            <Field label="생산일">
              <input
                type="date"
                className="orders-input"
                value={data.productionDate}
                onChange={(e) => set("productionDate", e.target.value)}
              />
            </Field>
            <Field label="발송일">
              <input
                type="date"
                className="orders-input"
                value={data.shipDate}
                onChange={(e) => set("shipDate", e.target.value)}
              />
            </Field>
          </div>

          <Field label="거래처명">
            <input
              type="text"
              className="orders-input"
              value={data.client}
              onChange={(e) => set("client", e.target.value)}
              placeholder={clientSuggestions.length > 0 ? "기존 거래처는 자동 추천됩니다" : "예: A마트"}
              list="order-client-suggestions"
              autoComplete="off"
            />
            {clientSuggestions.length > 0 && (
              <datalist id="order-client-suggestions">
                {clientSuggestions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            )}
          </Field>

          <Field label="생산품목">
            <input
              type="text"
              className="orders-input"
              value={data.product}
              onChange={(e) => set("product", e.target.value)}
              placeholder={productSuggestions.length > 0 ? "기존 품목은 자동 추천됩니다" : "예: 대구순살"}
              list="order-product-suggestions"
              autoComplete="off"
            />
            {productSuggestions.length > 0 && (
              <datalist id="order-product-suggestions">
                {productSuggestions.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            )}
          </Field>

          <div className="form-row">
            <Field label="규격 (g)">
              <input
                type="text"
                inputMode="numeric"
                className="orders-input"
                value={data.spec}
                onChange={(e) => set("spec", e.target.value)}
                placeholder="100"
              />
            </Field>
            <Field label="중량 (kg)">
              <input
                type="text"
                inputMode="numeric"
                className="orders-input"
                value={data.weight}
                onChange={(e) => set("weight", e.target.value)}
                placeholder="10"
              />
            </Field>
            <Field label="수량">
              <input
                type="text"
                inputMode="numeric"
                className="orders-input"
                value={data.quantity}
                onChange={(e) => set("quantity", e.target.value)}
                placeholder="50"
              />
            </Field>
          </div>

          <Field label="상태">
            <select
              className="orders-input"
              value={data.status}
              onChange={(e) => set("status", e.target.value as OrderInput["status"])}
            >
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="비고 (메모)">
            <textarea
              className="orders-input orders-textarea"
              value={data.note}
              onChange={(e) => set("note", e.target.value)}
              placeholder="예: 포장 색상 빨강, 직접 전달 요청, 결제 후 진행"
              rows={3}
            />
          </Field>
        </div>

        <div className="modal-footer">
          {onDelete && (
            <button className="btn-danger" onClick={onDelete} disabled={saving}>
              삭제
            </button>
          )}
          <div className="modal-footer-right">
            {onClone && (
              <button
                className="btn-secondary"
                onClick={onClone}
                disabled={saving}
                title="이 발주의 거래처·품목·규격·중량·수량·메모를 복사한 새 발주를 만듭니다"
              >
                복제
              </button>
            )}
            <button className="btn-secondary" onClick={onClose} disabled={saving}>
              취소
            </button>
            <button className="btn-primary" onClick={onSave} disabled={saving}>
              {saving ? "저장 중..." : mode === "create" ? "등록" : "수정"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {children}
    </div>
  );
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekStartOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

function addDaysDate(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}
