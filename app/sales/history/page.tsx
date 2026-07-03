"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Activity = {
  id: string;
  event_type: string;
  summary: string;
  actor: string | null;
  created_at: string;
};

// 매출 이벤트 유형 → 라벨·색 (b2b-activity.ts 의 sales.* 이벤트와 1:1)
const SALES_TYPE: Record<string, { label: string; bg: string; fg: string }> = {
  "sales.upload":        { label: "업로드",   bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  "sales.upload_revert": { label: "되돌리기", bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  "sales.report_sent":   { label: "리포트",   bg: "var(--sm-info-bg)",    fg: "var(--sm-info)" },
  "sales.config_changed":{ label: "설정",     bg: "var(--sm-bg)",         fg: "var(--sm-text-mid)" },
  "sales.phone_lookup":  { label: "주문검색", bg: "var(--sm-bg)",         fg: "var(--sm-text-light)" },
};
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체 유형" },
  { value: "sales.upload", label: "업로드" },
  { value: "sales.upload_revert", label: "되돌리기" },
  { value: "sales.report_sent", label: "리포트 발송" },
  { value: "sales.config_changed", label: "채널 설정 변경" },
  { value: "sales.phone_lookup", label: "주문검색(전화조회)" },
];
const ACTOR_OPTIONS = ["", "지인", "예지", "현석", "관리자"];
const PAGE = 50;

export default function SalesHistoryPage() {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tick, setTick] = useState(0); // 새로고침 트리거

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
      return `/api/sales/activity?${p.toString()}`;
    },
    [type, actor, q, dateFrom, dateTo]
  );

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
    return () => { cancelled = true; clearTimeout(t); };
  }, [buildUrl, tick]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(items.length), { cache: "no-store" });
      const j = await res.json();
      if (res.ok && j.ok) {
        setItems((prev) => [...prev, ...(j.activities || [])]);
        setHasMore(!!j.hasMore);
      }
    } catch { /* 더 보기 실패는 조용히 무시 */ }
    setLoadingMore(false);
  }

  const hasFilter = !!(type || actor || q.trim() || dateFrom || dateTo);
  function reset() { setType(""); setActor(""); setQ(""); setDateFrom(""); setDateTo(""); }

  // 날짜(로컬=KST)별 그룹
  const groups = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const a of items) {
      const d = new Date(a.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const arr = map.get(key);
      if (arr) arr.push(a); else map.set(key, [a]);
    }
    return Array.from(map.entries());
  }, [items]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">활동 히스토리</h1>
          <p className="b2b-page-subtitle">
            매출 데이터 관련 활동을 시간순으로 영구 기록합니다 — 업로드·되돌리기·리포트 발송·채널 설정 변경·주문검색(전화조회).
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={() => setTick((t) => t + 1)} disabled={loading}>
            {loading ? "..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card">
        <div className="b2b-card-head" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <input type="text" className="b2b-search" placeholder="내용 검색 (파일명·수신자 등)"
            value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
          <select className="b2b-select" value={type} onChange={(e) => setType(e.target.value)} style={{ width: "auto" }}>
            {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="b2b-select" value={actor} onChange={(e) => setActor(e.target.value)} style={{ width: "auto" }}>
            {ACTOR_OPTIONS.map((a) => <option key={a} value={a}>{a === "" ? "전체 작업자" : a}</option>)}
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
            {hasFilter ? "조건에 맞는 이력이 없습니다." : "아직 기록된 매출 활동이 없습니다."}
          </div>
        ) : (
          <>
            <div className="b2b-history">
              {groups.map(([day, list]) => (
                <div key={day} className="b2b-history-group">
                  <div className="b2b-history-day">{formatDay(day)}</div>
                  {list.map((a) => {
                    const meta = SALES_TYPE[a.event_type];
                    return (
                      <div key={a.id} className="b2b-history-item is-static">
                        <span className="b2b-history-summary" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {meta && (
                            <span className="b2b-feed-pill" style={{ background: meta.bg, color: meta.fg, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                              {meta.label}
                            </span>
                          )}
                          <span>{a.summary}</span>
                        </span>
                        <span className="b2b-history-meta">
                          {a.actor ? `${a.actor} · ` : ""}{formatClock(a.created_at)}
                        </span>
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
    </div>
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
