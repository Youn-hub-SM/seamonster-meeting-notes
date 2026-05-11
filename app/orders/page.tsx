"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Order,
  OrderInput,
  OrderStatus,
  ORDER_STATUSES,
  EMPTY_ORDER,
  STATUS_COLORS,
  DateKind,
  DATE_KIND_LABEL,
  DATE_KIND_COLOR,
  ProductGroup,
  WeekGroup,
  groupByProduct,
  groupByWeek,
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
      setModal(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 중 오류");
    }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!confirm("정말 삭제하시겠어요?")) return;
    setError("");
    try {
      const res = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "삭제 실패");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
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
          <button className="btn-primary" onClick={() => setModal({ mode: "create", data: { ...EMPTY_ORDER } })}>
            + 새 발주 등록
          </button>
        </div>
      </div>

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
        />
      ) : view === "list" ? (
        <ListView
          orders={filteredOrders}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
          onDelete={handleDelete}
        />
      ) : view === "production" ? (
        <ProductionView
          orders={orders}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
        />
      ) : (
        <WeeklyView
          orders={filteredOrders}
          onEdit={(o) => setModal({ mode: "edit", data: { ...o } })}
        />
      )}

      {modal && (
        <OrderModal
          mode={modal.mode}
          data={modal.data}
          saving={saving}
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
        />
      )}
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
}: {
  orders: Order[];
  cursor: Date;
  setCursor: (d: Date) => void;
  onEdit: (o: Order) => void;
}) {
  const monthLabel = `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startWeekday = first.getDay(); // 0=일
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

    const result: { date: Date | null; iso: string; entries: { kind: DateKind; order: Order }[] }[] = [];
    for (let i = 0; i < startWeekday; i++) result.push({ date: null, iso: "", entries: [] });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), d);
      const iso = toISO(date);
      const entries: { kind: DateKind; order: Order }[] = [];
      for (const o of orders) {
        if (o.orderDate === iso) entries.push({ kind: "order", order: o });
        if (o.productionDate === iso) entries.push({ kind: "production", order: o });
        if (o.shipDate === iso) entries.push({ kind: "ship", order: o });
      }
      result.push({ date, iso, entries });
    }
    // 마지막 주 빈 셀
    while (result.length % 7 !== 0) result.push({ date: null, iso: "", entries: [] });
    return result;
  }, [cursor, orders]);

  const todayIso = toISO(new Date());

  return (
    <div>
      <div className="cal-nav">
        <button className="btn-secondary" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          ←
        </button>
        <div className="cal-month">{monthLabel}</div>
        <button className="btn-secondary" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          →
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            const d = new Date();
            setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          오늘
        </button>
      </div>

      <div className="cal-legend">
        {(Object.keys(DATE_KIND_LABEL) as DateKind[]).map((k) => (
          <span key={k} className="cal-legend-item">
            <span className="cal-legend-dot" style={{ background: DATE_KIND_COLOR[k] }} />
            {DATE_KIND_LABEL[k]}일
          </span>
        ))}
      </div>

      <div className="cal-grid">
        {["일", "월", "화", "수", "목", "금", "토"].map((w) => (
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
                <div className="cal-entries">
                  {cell.entries.map((e, idx) => (
                    <button
                      key={`${e.order.id}-${e.kind}-${idx}`}
                      className="cal-entry"
                      onClick={() => onEdit(e.order)}
                      style={{ borderLeftColor: DATE_KIND_COLOR[e.kind] }}
                      title={`${DATE_KIND_LABEL[e.kind]}일 · ${e.order.client} · ${e.order.product}`}
                    >
                      <span className="cal-entry-kind" style={{ color: DATE_KIND_COLOR[e.kind] }}>
                        {DATE_KIND_LABEL[e.kind]}
                      </span>
                      <span className="cal-entry-text">
                        {e.order.client || "-"} · {e.order.product || "-"}
                      </span>
                    </button>
                  ))}
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
}: {
  orders: Order[];
  onEdit: (o: Order) => void;
  onDelete: (id: string) => void;
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
    <div className="orders-table-wrap">
      <table className="orders-table">
        <thead>
          <tr>
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
          {sorted.map((o) => (
            <tr key={o.id} onClick={() => onEdit(o)}>
              <td className="cell-date">{o.orderDate || "-"}</td>
              <td className="cell-date">{o.productionDate || "-"}</td>
              <td className="cell-date">{o.shipDate || "-"}</td>
              <td>{o.client || "-"}</td>
              <td>{o.product || "-"}</td>
              <td>{formatSpec(o.spec) || "-"}</td>
              <td>{formatWeight(o.weight) || "-"}</td>
              <td>{o.quantity || "-"}</td>
              <td>
                <span
                  className="orders-status-pill"
                  style={{
                    background: STATUS_COLORS[o.status]?.bg,
                    color: STATUS_COLORS[o.status]?.fg,
                  }}
                >
                  {o.status}
                </span>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────
// 생산 현황 뷰 (계획 중 + 생산 중)
// ─────────────────────────────────────────────
function ProductionView({
  orders,
  onEdit,
}: {
  orders: Order[];
  onEdit: (o: Order) => void;
}) {
  const planning = useMemo(() => orders.filter((o) => o.status === "대기"), [orders]);
  const inProgress = useMemo(() => orders.filter((o) => o.status === "생산중"), [orders]);

  if (planning.length === 0 && inProgress.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🏭</div>
        <div className="empty-state-text">계획 중이거나 생산 중인 발주가 없습니다.</div>
      </div>
    );
  }

  return (
    <div className="prod-wrap">
      <ProductionSection
        title="계획 중"
        status="대기"
        orders={planning}
        onEdit={onEdit}
        emptyText="계획 중인 발주가 없습니다."
      />
      <ProductionSection
        title="생산 중"
        status="생산중"
        orders={inProgress}
        onEdit={onEdit}
        emptyText="생산 중인 발주가 없습니다."
      />
    </div>
  );
}

function ProductionSection({
  title,
  status,
  orders,
  onEdit,
  emptyText,
}: {
  title: string;
  status: OrderStatus;
  orders: Order[];
  onEdit: (o: Order) => void;
  emptyText: string;
}) {
  const groups = useMemo(() => groupByProduct(orders), [orders]);
  const accent = STATUS_COLORS[status];

  return (
    <section className="prod-section">
      <div className="prod-section-header">
        <h2 className="prod-section-title">
          <span
            className="prod-section-dot"
            style={{ background: accent.fg }}
            aria-hidden
          />
          {title}
        </h2>
        <span className="prod-section-count">발주 {orders.length}건 · 품목 {groups.length}종</span>
      </div>

      {orders.length === 0 ? (
        <div className="prod-empty">{emptyText}</div>
      ) : (
        <>
          <div className="prod-grid">
            {groups.map((g) => (
              <ProductGroupCard key={`${g.product}__${g.spec}`} group={g} onEdit={onEdit} />
            ))}
          </div>

          <details className="prod-orders-toggle">
            <summary>개별 발주 보기 ({orders.length}건)</summary>
            <div className="prod-orders-list">
              {orders.map((o) => (
                <button
                  key={o.id}
                  className="prod-order-row"
                  onClick={() => onEdit(o)}
                >
                  <span className="prod-order-client">{o.client || "거래처 미정"}</span>
                  <span className="prod-order-product">
                    {o.product || "-"}{o.spec ? ` · ${formatSpec(o.spec)}` : ""}
                  </span>
                  <span className="prod-order-meta">
                    {o.weight ? <span>중량 {formatWeight(o.weight)}</span> : null}
                    {o.quantity ? <span>수량 {o.quantity}</span> : null}
                  </span>
                  <span className="prod-order-date">
                    {o.shipDate ? `발송 ${o.shipDate}` : o.productionDate ? `생산 ${o.productionDate}` : o.orderDate ? `발주 ${o.orderDate}` : "-"}
                  </span>
                </button>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function ProductGroupCard({
  group,
  onEdit,
}: {
  group: ProductGroup;
  onEdit: (o: Order) => void;
}) {
  return (
    <div className="prod-card">
      <div className="prod-card-header">
        <div className="prod-card-product">{group.product}</div>
        {group.spec ? <div className="prod-card-spec">{formatSpec(group.spec)}</div> : null}
      </div>

      <div className="prod-card-stats">
        <div className="prod-card-stat">
          <span className="prod-card-stat-label">총 중량</span>
          <span className="prod-card-stat-value">
            {group.totalWeight ? `${formatNumber(group.totalWeight)}kg` : "-"}
          </span>
        </div>
        <div className="prod-card-stat">
          <span className="prod-card-stat-label">총 수량</span>
          <span className="prod-card-stat-value">{formatNumber(group.totalQuantity) || "-"}</span>
        </div>
      </div>

      <div className="prod-card-meta">
        <div className="prod-card-meta-row">
          <span className="prod-card-meta-label">거래처</span>
          <span className="prod-card-meta-value">
            {group.clients.length > 0 ? group.clients.join(", ") : "-"}
          </span>
        </div>
        <div className="prod-card-meta-row">
          <span className="prod-card-meta-label">다음 일정</span>
          <span className="prod-card-meta-value">{group.nextDate || "-"}</span>
        </div>
      </div>

      <div className="prod-card-orders">
        {group.orders.map((o) => (
          <button
            key={o.id}
            className="prod-card-order"
            onClick={() => onEdit(o)}
            title="수정"
          >
            {o.client || "거래처 미정"}
            {o.weight ? ` · ${formatWeight(o.weight)}` : ""}
            {o.quantity ? ` × ${o.quantity}` : ""}
          </button>
        ))}
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
}: {
  orders: Order[];
  onEdit: (o: Order) => void;
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
        />
      ))}
    </div>
  );
}

function WeekCard({
  week,
  isCurrent,
  onEdit,
}: {
  week: WeekGroup;
  isCurrent: boolean;
  onEdit: (o: Order) => void;
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
              {week.productGroups.map((g) => (
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

        <details className="week-orders-toggle">
          <summary>개별 발주 보기 ({week.orders.length}건)</summary>
          <div className="week-orders-list">
            {week.orders.map((o) => (
              <button key={o.id} className="week-order-row" onClick={() => onEdit(o)}>
                <span className="week-order-date">{o.shipDate || "-"}</span>
                <span className="week-order-client">{o.client || "거래처 미정"}</span>
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
                >
                  {o.status}
                </span>
              </button>
            ))}
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
  onChange,
  onSave,
  onClose,
  onDelete,
}: {
  mode: "create" | "edit";
  data: OrderInput;
  saving: boolean;
  onChange: (d: OrderInput) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
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
              placeholder="예: A마트"
            />
          </Field>

          <Field label="생산품목">
            <input
              type="text"
              className="orders-input"
              value={data.product}
              onChange={(e) => set("product", e.target.value)}
              placeholder="예: 대구순살"
            />
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
        </div>

        <div className="modal-footer">
          {onDelete && (
            <button className="btn-danger" onClick={onDelete} disabled={saving}>
              삭제
            </button>
          )}
          <div className="modal-footer-right">
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
