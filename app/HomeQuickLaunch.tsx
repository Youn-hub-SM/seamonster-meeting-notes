"use client";

// 홈 퀵런치 — 즐겨찾는 메뉴(사이드바와 같은 데이터)와 최근 방문을 큰 타일로.
// 타일은 기존 .home-tool-card(구 홈의 런처 카드) 재사용.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NAV } from "./nav";
import Icon, { type IconName } from "./components/Icon";
import { readRecents, type RecentPage } from "./lib/recent-pages";

type Fav = { href: string; label: string };

export default function HomeQuickLaunch() {
  const [favorites, setFavorites] = useState<Fav[]>([]);
  const [recents, setRecents] = useState<RecentPage[]>([]);

  useEffect(() => {
    fetch("/api/b2b/favorites", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setFavorites(j.favorites || []); })
      .catch(() => {});
    setRecents(readRecents());
  }, []);

  // href → 아이콘 (사이드바와 동일 규칙: 하위 메뉴는 상위 툴 아이콘)
  const iconForHref = useMemo(() => {
    const m = new Map<string, IconName>();
    for (const cat of NAV) for (const t of cat.tools) {
      m.set(t.href, t.icon);
      for (const sub of t.menu || []) if (!m.has(sub.href)) m.set(sub.href, t.icon);
    }
    return (href: string): IconName => m.get(href) || "home";
  }, []);

  const shownRecents = recents.filter((r) => !favorites.some((f) => f.href === r.href)).slice(0, 4);

  if (favorites.length === 0 && shownRecents.length === 0) return null;

  const Tile = ({ href, label, icon }: { href: string; label: string; icon: IconName }) => (
    <Link href={href} className="home-tool-card">
      <span className="sm-row" style={{ gap: 10, minWidth: 0 }}>
        <Icon name={icon} size={20} />
        <span className="home-tool-name sm-ellipsis" style={{ fontSize: 17 }}>{label}</span>
      </span>
    </Link>
  );

  return (
    <>
      {favorites.length > 0 && (
        <section className="home-section">
          <h2 className="home-section-title">즐겨찾는 메뉴</h2>
          <div className="home-grid" style={{ marginTop: 14 }}>
            {favorites.map((f) => <Tile key={f.href} href={f.href} label={f.label} icon={iconForHref(f.href)} />)}
          </div>
        </section>
      )}
      {shownRecents.length > 0 && (
        <section className="home-section">
          <h2 className="home-section-title">최근 방문</h2>
          <div className="home-grid" style={{ marginTop: 14 }}>
            {shownRecents.map((r) => <Tile key={r.href} href={r.href} label={r.label} icon={r.icon || iconForHref(r.href)} />)}
          </div>
        </section>
      )}
    </>
  );
}
