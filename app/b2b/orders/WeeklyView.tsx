"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  OrderListItem,
  STATUS_COLORS,
  STATUS_SHORT,
  formatMoney,
  getUrgency,
  URGENCY_LABEL,
} from "@/app/lib/b2b-orders";

type WeekGroup = {
  weekStart: string;        // ISO 'YYYY-MM-DD' (월요일). "" 면 발송일 미정
  weekEnd: string;          // 일요일
  label: string;
  orders: OrderListItem[];
  total: number;
};

export default function WeeklyView({
  orders,
  todayIso,
}: {
  orders: OrderListItem[];
  todayIso: string;
}) {
  const weeks = useMemo(() => groupByShipWeek(orders), [orders]);
  const thisWeekStart = useMemo(() => toISO(weekStartOf(new Date())), []);

  if (weeks.length === 0) {
    return (
      <div className="b2b-empty">
        <div className="b2b-empty-icon">📅</div>
        표시할 발주가 없습니다.
      </div>
    );
  }

  return (
    <div className="b2b-week-wrap">
      {weeks.map((w) => {
        const isCurrent = w.weekStart === thisWeekStart;
        const isUnscheduled = !w.weekStart;
        return (
          <section
            key={w.weekStart || "unscheduled"}
            className={`b2b-week-card ${isCurrent ? "is-current" : ""} ${isUnscheduled ? "is-unscheduled" : ""}`}
          >
            <div className="b2b-week-head">
              <div className="b2b-week-title-block">
                <h2 className="b2b-week-title">{w.label}</h2>
                {isCurrent && <span className="b2b-week-badge">이번 주</span>}
              </div>
              <div className="b2b-week-totals">
                <span><em>발주</em><strong>{w.orders.length}건</strong></span>
                <span><em>합계</em><strong className="b2b-money">{formatMoney(w.total)}원</strong></span>
              </div>
            </div>

            <div className="b2b-week-list">
              {w.orders.map((o) => {
                const urgency = getUrgency(o, todayIso);
                return (
                  <Link
                    key={o.id}
                    href={`/b2b/orders/${o.id}`}
                    className={`b2b-week-row ${urgency !== "normal" ? `is-${urgency}` : ""}`}
                  >
                    <span className="b2b-week-row-date">
                      {o.ship_date ? o.ship_date.slice(5) : "-"}
                      {urgency !== "normal" && (
                        <span className={`b2b-urgency-pill is-${urgency}`} style={{ marginLeft: 6 }}>
                          {URGENCY_LABEL[urgency]}
                        </span>
                      )}
                    </span>
                    <span className="b2b-week-row-company">{o.company_name}</span>
                    <span className="b2b-week-row-no">{o.order_no}</span>
                    <span className="b2b-week-row-total b2b-money">{formatMoney(o.total)}원</span>
                    <span
                      className="b2b-status-pill"
                      style={{
                        background: STATUS_COLORS[o.status]?.bg,
                        color: STATUS_COLORS[o.status]?.fg,
                      }}
                    >
                      {STATUS_SHORT[o.status]}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────
function groupByShipWeek(orders: OrderListItem[]): WeekGroup[] {
  const map = new Map<string, WeekGroup>();

  for (const o of orders) {
    let key = "";        // "" = unscheduled
    let label = "발송일 미정";
    let weekEnd = "";
    if (o.ship_date) {
      const d = new Date(o.ship_date + "T00:00:00");
      const start = weekStartOf(d);
      key = toISO(start);
      const end = addDaysDate(start, 6);
      weekEnd = toISO(end);
      label = formatWeekLabel(start, end);
    }
    let g = map.get(key);
    if (!g) {
      g = { weekStart: key, weekEnd, label, orders: [], total: 0 };
      map.set(key, g);
    }
    g.orders.push(o);
    g.total += Number(o.total) || 0;
  }

  // 정렬: 미정은 맨 아래로, 나머지는 주 시작일 오름차순
  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (!a.weekStart && !b.weekStart) return 0;
    if (!a.weekStart) return 1;
    if (!b.weekStart) return -1;
    return a.weekStart.localeCompare(b.weekStart);
  });

  // 각 주 내 발주는 발송일 → 발주번호 순
  for (const g of groups) {
    g.orders.sort((a, b) => {
      const ka = a.ship_date || "9999";
      const kb = b.ship_date || "9999";
      return ka.localeCompare(kb) || a.order_no.localeCompare(b.order_no);
    });
  }

  return groups;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysDate(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function weekStartOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

function formatWeekLabel(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  const y = start.getFullYear();
  const sm = start.getMonth() + 1;
  const sd = start.getDate();
  const em = end.getMonth() + 1;
  const ed = end.getDate();
  if (sameMonth) {
    return `${y}년 ${sm}월 ${sd}일 ~ ${ed}일`;
  }
  return `${y}년 ${sm}월 ${sd}일 ~ ${em}월 ${ed}일`;
}
