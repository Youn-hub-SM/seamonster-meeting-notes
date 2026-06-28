"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// 다른 컴포넌트(발주 목록·입금 모달 등)에서 상태를 바꾼 직후
// 이 함수를 호출하면 최근 변경 피드가 즉시 새로고침됨.
export function pingActivityFeed() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("b2b:activity"));
  }
}

type Activity = {
  id: string;
  event_type: string;
  summary: string;
  actor: string | null;
  order_id: string | null;
  order_no: string | null;
  created_at: string;
};

// 마지막으로 '최근 변경'을 연 시각(ms) — 이후 생긴 변경만 배지로 카운트
const SEEN_KEY = "b2b:activity:lastSeenMs";

export default function ActivityFeed() {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [lastSeenMs, setLastSeenMs] = useState<number>(0);
  const pathname = usePathname();
  const initRef = useRef(false);

  // 저장된 '봤음' 기준 시각 로드
  useEffect(() => {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw) setLastSeenMs(Number(raw) || 0);
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/b2b/activity?limit=30", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      const acts: Activity[] = j.activities || [];
      setItems(acts);
      // 첫 로드 시 기준이 없으면 현재 최신 시각을 '봤음'으로 설정(배지 0에서 시작)
      if (!initRef.current) {
        initRef.current = true;
        const stored = localStorage.getItem(SEEN_KEY);
        if (!stored && acts.length) {
          const newest = new Date(acts[0].created_at).getTime();
          localStorage.setItem(SEEN_KEY, String(newest));
          setLastSeenMs(newest);
        }
      }
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

  // 안 본 변경 수
  const unseen = items.filter((a) => new Date(a.created_at).getTime() > lastSeenMs).length;

  function markSeen() {
    if (items.length) {
      const newest = new Date(items[0].created_at).getTime();
      localStorage.setItem(SEEN_KEY, String(newest));
      setLastSeenMs(newest);
    }
  }

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) markSeen(); // 열면 배지 초기화
      return next;
    });
  }

  return (
    <div className="b2b-feed-wrap">
      <button
        type="button"
        className={`b2b-feed-pill ${open ? "is-open" : ""}`}
        onClick={toggle}
        title="최근 변경 내역"
        aria-expanded={open}
      >
        최근 변경
        {unseen > 0 && (
          <span className="b2b-feed-badge">{unseen > 99 ? "99+" : unseen}</span>
        )}
      </button>

      {open && (
        <>
          <div className="b2b-feed-backdrop" onClick={() => setOpen(false)} />
          <div className="b2b-feed-pop" role="dialog" aria-label="최근 변경">
            <div className="b2b-feed-head">
              <h2 className="b2b-feed-title">최근 변경</h2>
              <button type="button" className="b2b-feed-refresh" onClick={load} title="새로고침">
                ↻
              </button>
            </div>

            {error && <div className="b2b-error" style={{ fontSize: 12 }}>{error}</div>}

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
                      <span className="b2b-feed-time">
                        {a.actor ? `${a.actor} · ` : ""}
                        {formatTime(a.created_at)}
                      </span>
                    </>
                  );
                  return (
                    <li key={a.id} className="b2b-feed-item">
                      {a.order_id ? (
                        <Link
                          href={`/b2b/orders/${a.order_id}`}
                          className="b2b-feed-link"
                          onClick={() => setOpen(false)}
                        >
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
          </div>
        </>
      )}
    </div>
  );
}

// 절대 시간: "6월 8일 14:30" (24시간제)
function formatTime(iso: string): string {
  const d = new Date(iso);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month}월 ${day}일 ${hh}:${mm}`;
}
