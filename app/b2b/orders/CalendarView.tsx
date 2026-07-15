"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  OrderListItem,
  STATUS_COLORS,
  STATUS_SHORT,
  SHIPMENT_STATUS_COLORS,
  ShipmentStatus,
  getUrgency,
  nextPendingShipDate,
} from "@/app/lib/b2b-orders";

type DateKind = "order" | "production" | "ship";

const DATE_KIND_LABEL: Record<DateKind, string> = {
  order: "발주",
  production: "생산",
  ship: "발송",
};

const DATE_KIND_COLOR: Record<DateKind, string> = {
  order: "var(--sm-text-light)",
  production: "var(--sm-info)",
  ship: "var(--sm-orange)",
};

export default function CalendarView({
  orders,
  todayIso,
}: {
  orders: OrderListItem[];
  todayIso: string;
}) {
  const isMobile = useIsMobile();
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [weekStart, setWeekStart] = useState<Date>(() => weekStartOf(new Date()));
  const [visibleKinds, setVisibleKinds] = useState<Record<DateKind, boolean>>({
    order: false,
    production: true,
    ship: true,
  });

  function toggleKind(k: DateKind) {
    setVisibleKinds((prev) => ({ ...prev, [k]: !prev[k] }));
  }

  const navLabel = useMemo(() => {
    if (isMobile) {
      const start = addDaysDate(weekStart, -7);
      const end = addDaysDate(weekStart, 13);
      const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
      return `${fmt(start)} ~ ${fmt(end)}`;
    }
    return `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
  }, [isMobile, weekStart, cursor]);

  // 셀 배열 만들기
  type Entry = { kind: DateKind; order: OrderListItem; shipStatus?: ShipmentStatus };
  const cells = useMemo(() => {
    const result: { date: Date | null; iso: string; entries: Entry[] }[] = [];

    function entriesFor(iso: string): Entry[] {
      const out: Entry[] = [];
      for (const o of orders) {
        if (visibleKinds.order && o.order_date === iso) out.push({ kind: "order", order: o });
        if (visibleKinds.production && o.production_date === iso) out.push({ kind: "production", order: o });
        if (visibleKinds.ship) {
          // 발송 일정(분할 발송)을 각 날짜에 표시 — 일정별 상태 사용. 일정 없으면 헤더 발송일로 폴백.
          const dated = (o.shipments ?? []).filter((s) => s.ship_date);
          if (dated.length > 0) {
            for (const s of dated) {
              if (s.ship_date === iso) out.push({ kind: "ship", order: o, shipStatus: s.status });
            }
          } else if (o.ship_date === iso) {
            out.push({ kind: "ship", order: o });
          }
        }
      }
      return out;
    }

    if (isMobile) {
      const start = addDaysDate(weekStart, -7);
      for (let i = 0; i < 21; i++) {
        const date = addDaysDate(start, i);
        const iso = toISO(date);
        result.push({ date, iso, entries: entriesFor(iso) });
      }
      return result;
    }

    // 데스크탑: 한 달 (월~일이 아니라 일~토 시작 — 한국 캘린더 일반)
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startWeekday = first.getDay(); // 0=일
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

    for (let i = 0; i < startWeekday; i++) result.push({ date: null, iso: "", entries: [] });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), d);
      const iso = toISO(date);
      result.push({ date, iso, entries: entriesFor(iso) });
    }
    while (result.length % 7 !== 0) result.push({ date: null, iso: "", entries: [] });
    return result;
  }, [isMobile, weekStart, cursor, orders, visibleKinds]);

  return (
    <div>
      <div className="b2b-cal-nav">
        <button
          type="button"
          className="b2b-btn-secondary"
          onClick={() => {
            if (isMobile) setWeekStart((prev) => addDaysDate(prev, -7));
            else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
          }}
        >
          ←
        </button>
        <div className="b2b-cal-label">{navLabel}</div>
        <button
          type="button"
          className="b2b-btn-secondary"
          onClick={() => {
            if (isMobile) setWeekStart((prev) => addDaysDate(prev, 7));
            else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
          }}
        >
          →
        </button>
        <button
          type="button"
          className="b2b-btn-secondary"
          onClick={() => {
            const d = new Date();
            if (isMobile) setWeekStart(weekStartOf(d));
            else setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          오늘
        </button>
      </div>

      <div className="b2b-cal-legend">
        <span className="b2b-cal-legend-hint">표시:</span>
        {(Object.keys(DATE_KIND_LABEL) as DateKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`b2b-cal-legend-item ${visibleKinds[k] ? "is-active" : "is-inactive"}`}
            onClick={() => toggleKind(k)}
            aria-pressed={visibleKinds[k]}
            title={`${DATE_KIND_LABEL[k]}일 ${visibleKinds[k] ? "숨기기" : "보이기"}`}
          >
            <span className="b2b-cal-legend-dot" style={{ background: DATE_KIND_COLOR[k] }} />
            {DATE_KIND_LABEL[k]}일
          </button>
        ))}
      </div>

      <div className={`b2b-cal-grid ${isMobile ? "is-mobile" : ""}`}>
        {(isMobile
          ? ["월", "화", "수", "목", "금", "토", "일"]
          : ["일", "월", "화", "수", "목", "금", "토"]
        ).map((w) => (
          <div key={w} className="b2b-cal-weekday">{w}</div>
        ))}
        {cells.map((cell, i) => (
          <div
            key={i}
            className={`b2b-cal-cell ${cell.date ? "" : "is-empty"} ${cell.iso === todayIso ? "is-today" : ""}`}
          >
            {cell.date && (
              <>
                <div className="b2b-cal-date">{cell.date.getDate()}</div>
                <div className="b2b-cal-entries">
                  {cell.entries.map((e, idx) => {
                    const urgency = getUrgency({ ...e.order, ship_date: nextPendingShipDate(e.order) }, todayIso);
                    // 발송 일정 항목은 일정 상태(발송대기/중/완료) 배지, 그 외는 발주 상태 배지
                    const badge = e.shipStatus
                      ? { label: STATUS_SHORT[e.shipStatus] || e.shipStatus, colors: SHIPMENT_STATUS_COLORS[e.shipStatus] }
                      : { label: STATUS_SHORT[e.order.status], colors: STATUS_COLORS[e.order.status] };
                    return (
                      <Link
                        key={`${e.order.id}-${e.kind}-${idx}`}
                        href={`/b2b/orders/${e.order.id}`}
                        className={`b2b-cal-entry ${urgency !== "normal" ? `is-${urgency}` : ""}`}
                        style={{ borderLeftColor: DATE_KIND_COLOR[e.kind] }}
                        title={`${DATE_KIND_LABEL[e.kind]}일 · ${e.order.company_name} · ${e.order.order_no}${e.shipStatus ? ` · ${e.shipStatus}` : ""}`}
                      >
                        <span className="b2b-cal-entry-kind" style={{ color: DATE_KIND_COLOR[e.kind] }}>
                          {DATE_KIND_LABEL[e.kind]}
                        </span>
                        <span className="b2b-cal-entry-text">{e.order.company_name}</span>
                        <span
                          className="b2b-cal-entry-status"
                          style={{ background: badge.colors?.bg, color: badge.colors?.fg }}
                        >
                          {badge.label}
                        </span>
                      </Link>
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
// helpers
// ─────────────────────────────────────────────
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
