"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Change = { field: string; label: string; from: string; to: string };
type Row = {
  id: string;
  event_type: string;
  summary: string;
  actor: string | null;
  created_at: string;
  meta: { source?: string | null; changes?: Change[]; name?: string; sku?: string | null } | null;
};

const ACTION: Record<string, { label: string; bg: string; fg: string }> = {
  "product.created": { label: "등록", bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  "product.updated": { label: "수정", bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  "product.deleted": { label: "삭제", bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
};
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "product.created,product.updated,product.deleted", label: "전체 유형" },
  { value: "product.created", label: "등록만" },
  { value: "product.updated", label: "수정만" },
  { value: "product.deleted", label: "삭제만" },
];
const ACTOR_OPTIONS = ["", "지인", "예지", "현석", "관리자"];
const ALL = "product.created,product.updated,product.deleted";
const PAGE = 50;

export default function ProductHistoryPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const [type, setType] = useState(ALL);
  const [actor, setActor] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tick, setTick] = useState(0);

  const buildUrl = useCallback(
    (offset: number) => {
      const p = new URLSearchParams();
      p.set("limit", String(PAGE));
      p.set("offset", String(offset));
      p.set("type", type || ALL); // 항상 product.* 로 스코프 고정
      if (actor) p.set("actor", actor);
      if (q.trim()) p.set("q", q.trim());
      if (dateFrom) p.set("date_from", dateFrom);
      if (dateTo) p.set("date_to", dateTo);
      return `/api/b2b/activity?${p.toString()}`;
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

  const hasFilter = !!(type !== ALL || actor || q.trim() || dateFrom || dateTo);
  function reset() { setType(ALL); setActor(""); setQ(""); setDateFrom(""); setDateTo(""); }

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const a of items) {
      const d = new Date(a.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const arr = map.get(key);
      if (arr) arr.push(a); else map.set(key, [a]);
    }
    return Array.from(map.entries());
  }, [items]);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">상품 마스터 변경 기록</h1>
          <p className="b2b-page-subtitle">
            상품 마스터의 모든 변경(등록·수정·삭제)을 항목별 이전값→새값까지 영구 기록합니다.
            수동 편집·엑셀 업로드·품목 업로드(생산) 경로 모두 포함.
          </p>
        </div>
        <div className="b2b-page-actions">
          <Link className="b2b-btn-secondary" href="/b2b/products">← 상품 목록</Link>
          <button className="b2b-btn-secondary" onClick={() => setTick((t) => t + 1)} disabled={loading}>
            {loading ? "..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card">
        <div className="b2b-card-head" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <input type="text" className="b2b-search" placeholder="품목명·SKU 검색"
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
            {hasFilter ? "조건에 맞는 변경 기록이 없습니다." : "아직 기록된 변경이 없습니다."}
          </div>
        ) : (
          <>
            <div className="b2b-history">
              {groups.map(([day, list]) => (
                <div key={day} className="b2b-history-group">
                  <div className="b2b-history-day">{formatDay(day)}</div>
                  {list.map((a) => {
                    const act = ACTION[a.event_type] || { label: "변경", bg: "var(--sm-bg)", fg: "var(--sm-text-mid)" };
                    const name = a.meta?.name || stripSummary(a.summary);
                    const sku = a.meta?.sku;
                    const source = a.meta?.source;
                    const changes = a.meta?.changes || [];
                    return (
                      <div key={a.id} className="b2b-history-item is-static" style={{ display: "block" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span className="b2b-feed-pill" style={{ background: act.bg, color: act.fg, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{act.label}</span>
                          <strong style={{ fontSize: 13.5 }}>{name}</strong>
                          {sku && <span className="sm-faint" style={{ fontSize: 11 }}>{sku}</span>}
                          {source && <span className="b2b-feed-pill" style={{ background: "var(--sm-bg)", color: "var(--sm-text-light)", fontSize: 10.5, fontWeight: 600 }}>{source}</span>}
                          <span className="b2b-history-meta" style={{ marginLeft: "auto" }}>
                            {a.actor ? `${a.actor} · ` : ""}{formatClock(a.created_at)}
                          </span>
                        </div>
                        {changes.length > 0 && (
                          <ul style={{ margin: "6px 0 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                            {changes.map((c, i) => (
                              <li key={i} style={{ fontSize: 12, color: "var(--sm-text-mid)", display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ minWidth: 76, color: "var(--sm-text-light)" }}>{c.label}</span>
                                <span style={{ textDecoration: "line-through", color: "var(--sm-text-light)" }}>{c.from}</span>
                                <span>→</span>
                                <strong>{c.to}</strong>
                              </li>
                            ))}
                          </ul>
                        )}
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

// meta.name 이 없는 옛 기록: 요약에서 이모지·접두 제거해 품목명 근사치 추출
function stripSummary(s: string): string {
  return s.replace(/^[^가-힣A-Za-z0-9]*상품 마스터 (등록|수정|삭제) · /, "").replace(/ · \d+개 항목$/, "").trim() || s;
}
function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];
  return `${m}월 ${d}일 (${wd})`;
}
function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
