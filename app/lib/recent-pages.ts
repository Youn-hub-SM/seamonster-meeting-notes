// 최근 방문 화면 기록 — localStorage(브라우저별), 사이드바 네비(NAV) 항목 단위.
// 상세 페이지(/b2b/orders/123 등)는 가장 가까운 네비 항목(발주)으로 귀속돼
// 타일이 항상 목록/도구 진입점을 가리킨다.

import { NAV } from "../nav";
import type { IconName } from "../components/Icon";

export type RecentPage = { href: string; label: string; icon: IconName };

const KEY = "sm_recents_v1";
const MAX = 8;

export function resolveNavEntry(pathname: string): RecentPage | null {
  if (pathname === "/" || pathname.startsWith("/b2b/login")) return null;
  let best: RecentPage | null = null;
  let bestLen = 0;
  for (const cat of NAV) {
    for (const t of cat.tools) {
      const candidates = [
        { href: t.href, label: t.label },
        ...(t.menu || []).map((m) => ({ href: m.href, label: `${t.label} · ${m.label}` })),
      ];
      for (const c of candidates) {
        if (/^https?:/.test(c.href)) continue; // 외부 링크(가이드 등)는 기록 안 함
        if ((pathname === c.href || pathname.startsWith(c.href + "/")) && c.href.length > bestLen) {
          best = { href: c.href, label: c.label, icon: t.icon };
          bestLen = c.href.length;
        }
      }
    }
  }
  return best;
}

export function recordVisit(pathname: string) {
  const entry = resolveNavEntry(pathname);
  if (!entry) return;
  try {
    const prev = readRecents();
    const next = [entry, ...prev.filter((p) => p.href !== entry.href)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 시크릿 모드 등 저장 실패는 무시 — 기능엔 영향 없음
  }
}

export function readRecents(): RecentPage[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.href === "string" && typeof r.label === "string") : [];
  } catch {
    return [];
  }
}
