// 업데이트 노트 '새 항목' 수 — 사이드바 배지와 홈의 '새 업데이트 N건' 링크가 같은 계산을 쓴다(2026-10-14 D2).
//  기준 = 이 브라우저에서 마지막으로 업데이트 노트를 본 시각(localStorage updates_seen_at, /updates 에 들어갈 때 갱신).
//  한 번도 본 적이 없으면 최근 7일. 항목 날짜는 일 단위라, 본 날짜보다 뒤(다음 날부터)인 항목만 새 것으로 센다.
import { CHANGELOG } from "./changelog";

export const UPDATES_SEEN_KEY = "updates_seen_at";

const kstDate = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

export function readUpdatesSeenAt(): number | null {
  try {
    const v = localStorage.getItem(UPDATES_SEEN_KEY);
    const n = v ? Date.parse(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function markUpdatesSeen(): void {
  try { localStorage.setItem(UPDATES_SEEN_KEY, new Date().toISOString()); } catch {}
}

// seenAt 이 없으면 최근 7일(오늘 포함)
export function countNewUpdates(seenAt: number | null, now = Date.now()): number {
  const since = seenAt != null ? kstDate(seenAt) : kstDate(now - 7 * 86400e3);
  const today = kstDate(now);
  return CHANGELOG.filter((e) => (seenAt != null ? e.date > since : e.date >= since) && e.date <= today).length;
}
