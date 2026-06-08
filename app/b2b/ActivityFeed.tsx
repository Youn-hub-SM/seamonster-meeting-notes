"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Activity = {
  id: string;
  event_type: string;
  summary: string;
  order_id: string | null;
  order_no: string | null;
  created_at: string;
};

export default function ActivityFeed() {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/b2b/activity?limit=30", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setItems(j.activities || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // 다른 탭/창에서 작업 후 돌아오면 자동 새로고침
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return (
    <aside className="b2b-feed">
      <div className="b2b-feed-head">
        <h2 className="b2b-feed-title">최근 변경</h2>
        <button type="button" className="b2b-feed-refresh" onClick={load} title="새로고침">
          ↻
        </button>
      </div>

      {error && <div className="b2b-error" style={{ fontSize: 13 }}>{error}</div>}

      {loading ? (
        <div className="b2b-feed-empty">불러오는 중...</div>
      ) : items.length === 0 ? (
        <div className="b2b-feed-empty">
          아직 변경 내역이 없습니다.
          <br />
          발주 등록·상태 변경·입금이 생기면 여기에 쌓입니다.
        </div>
      ) : (
        <ul className="b2b-feed-list">
          {items.map((a) => {
            const body = (
              <>
                <span className="b2b-feed-summary">{a.summary}</span>
                <span className="b2b-feed-time">{relativeTime(a.created_at)}</span>
              </>
            );
            return (
              <li key={a.id} className="b2b-feed-item">
                {a.order_id ? (
                  <Link href={`/b2b/orders/${a.order_id}`} className="b2b-feed-link">
                    {body}
                  </Link>
                ) : (
                  <div className="b2b-feed-link is-static">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

// 상대 시간: 방금 / N분 전 / N시간 전 / N일 전 / 날짜
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "방금";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
