"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// 다른 컴포넌트(발주 목록·입금 모달 등)에서 상태를 바꾼 직후
// 이 함수를 호출하면 우측 피드가 즉시 새로고침됨.
export function pingActivityFeed() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("b2b:activity"));
  }
}

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
  const pathname = usePathname();

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

  // 페이지 이동 시마다 새로고침 (예: 발주 등록 후 목록으로 이동 → 즉시 반영)
  useEffect(() => {
    load();
  }, [load, pathname]);

  useEffect(() => {
    // 다른 탭/창에서 작업 후 돌아오면 즉시 새로고침
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);

    // 같은 페이지에서 인라인 변경 직후 pingActivityFeed() 호출 시 즉시 반영
    const onPing = () => load();
    window.addEventListener("b2b:activity", onPing);

    // 주기적 폴링(20초) — 같은 창에서 다른 사람이 바꾼 것도 반영.
    // 탭이 백그라운드면 멈춰서 불필요한 요청 방지.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 20000);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("b2b:activity", onPing);
      clearInterval(interval);
    };
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
