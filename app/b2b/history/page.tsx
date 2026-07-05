"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Activity = {
  id: string;
  event_type: string;
  summary: string;
  actor: string | null;
  order_id: string | null;
  order_no: string | null;
  created_at: string;
};

// 이벤트 유형 필터 옵션 (b2b-activity.ts 의 event_type 과 1:1)
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체 유형" },
  { value: "order.created", label: "발주 등록" },
  { value: "order.status_changed", label: "발주 상태" },
  { value: "shipment.status_changed", label: "발송 차수 상태" },
  { value: "order.payment_status_changed", label: "입금 상태" },
  { value: "order.tax_invoice_changed", label: "세금계산서" },
  { value: "payment.added", label: "입금 기록" },
  { value: "order.deleted", label: "발주 삭제" },
  { value: "company.created,company.updated,company.deleted", label: "업체 변경" },
];
// 상품 마스터 변경(product.*)은 전용 '변경 기록'(/b2b/products/history)에서 관리 — 여기선 제외.

const ACTOR_OPTIONS = ["", "지인", "예지", "현석", "관리자"];
const PAGE = 50;

export default function HistoryPage() {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  // 필터
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const buildUrl = useCallback(
    (offset: number) => {
      const p = new URLSearchParams();
      p.set("limit", String(PAGE));
      p.set("offset", String(offset));
      if (type) p.set("type", type);
      if (actor) p.set("actor", actor);
      if (q.trim()) p.set("q", q.trim());
      if (dateFrom) p.set("date_from", dateFrom);
      if (dateTo) p.set("date_to", dateTo);
      return `/api/b2b/activity?${p.toString()}`;
    },
    [type, actor, q, dateFrom, dateTo]
  );

  // 필터 변경 시 디바운스 후 처음부터 다시 조회
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(buildUrl(0), { cache: "no-store" });
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setItems(j.activities || []);
        setHasMore(!!j.hasMore);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "조회 중 오류");
      }
      if (!cancelled) setLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [buildUrl]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(items.length), { cache: "no-store" });
      const j = await res.json();
      if (res.ok && j.ok) {
        setItems((prev) => [...prev, ...(j.activities || [])]);
        setHasMore(!!j.hasMore);
      }
    } catch {
      // 더 보기 실패는 조용히 무시
    }
    setLoadingMore(false);
  }

  const hasFilter = !!(type || actor || q.trim() || dateFrom || dateTo);
  function reset() {
    setType("");
    setActor("");
    setQ("");
    setDateFrom("");
    setDateTo("");
  }

  // 날짜(로컬)별 그룹
  const groups = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const a of items) {
      const d = new Date(a.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const arr = map.get(key);
      if (arr) arr.push(a);
      else map.set(key, [a]);
    }
    return Array.from(map.entries());
  }, [items]);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">히스토리</h1>
          <p className="b2b-page-subtitle">
            발주·업체·입금 등 B2B 도매 변경 이력을 시간순으로 영구 기록합니다. (상품 마스터 변경은 <a href="/b2b/products/history">상품 마스터 › 변경 기록</a>)
          </p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card">
        <div className="b2b-card-head" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <input
            type="text"
            className="b2b-search"
            placeholder="내용 검색 (발주번호·업체·메모)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <select className="b2b-select" value={type} onChange={(e) => setType(e.target.value)} style={{ width: "auto" }}>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select className="b2b-select" value={actor} onChange={(e) => setActor(e.target.value)} style={{ width: "auto" }}>
            {ACTOR_OPTIONS.map((a) => (
              <option key={a} value={a}>{a === "" ? "전체 작업자" : a}</option>
            ))}
          </select>
          <input type="date" className="b2b-input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: "auto" }} title="시작일" />
          <span style={{ color: "var(--sm-text-light)" }}>~</span>
          <input type="date" className="b2b-input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ width: "auto" }} title="종료일" />
          {hasFilter && (
            <button type="button" className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={reset}>
              필터 초기화
            </button>
          )}
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : items.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">🗒️</div>
            {hasFilter ? "조건에 맞는 이력이 없습니다." : "아직 기록된 이력이 없습니다."}
          </div>
        ) : (
          <>
            <div className="b2b-history">
              {groups.map(([day, list]) => (
                <div key={day} className="b2b-history-group">
                  <div className="b2b-history-day">{formatDay(day)}</div>
                  {list.map((a) => {
                    const body = (
                      <>
                        <span className="b2b-history-summary">{a.summary}</span>
                        <span className="b2b-history-meta">
                          {a.actor ? `${a.actor} · ` : ""}
                          {formatClock(a.created_at)}
                        </span>
                      </>
                    );
                    return a.order_id ? (
                      <Link key={a.id} href={`/b2b/orders/${a.order_id}`} className="b2b-history-item">
                        {body}
                      </Link>
                    ) : (
                      <div key={a.id} className="b2b-history-item is-static">
                        {body}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
              {hasMore ? (
                <button type="button" className="b2b-btn-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "불러오는 중..." : "더 보기"}
                </button>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--sm-text-light)" }}>마지막 기록까지 모두 표시했습니다.</span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// "2026-06-12" → "6월 12일 (목)"
function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];
  return `${m}월 ${d}일 (${wd})`;
}

// 시각만 "14:30"
function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
