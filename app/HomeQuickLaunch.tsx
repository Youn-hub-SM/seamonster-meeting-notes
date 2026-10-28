"use client";

// 홈 퀵런치 — 즐겨찾는 메뉴(사이드바와 같은 데이터)를 큰 타일로.
// 타일은 기존 .home-tool-card(구 홈의 런처 카드) 재사용.
// 최근 방문 블록은 제거(2026-08-24 대표 지시, 2026-10-14 사이드바 '최근'도 같은 이유로 삭제).
// 즐겨찾기가 비어 있으면(로그인했고 목록이 0) 역할 묶음 바로가기 4개(세일즈 / 생산·재고 / 마케팅 / CS — 2026-10-14 D3):
//  각 분류의 첫 툴로 가는 카드, 라벨은 분류명. NAV 에서 파생.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NAV, sortByNavOrder, navLabelParts } from "./nav";
import Icon, { type IconName } from "./components/Icon";

type Fav = { href: string; label: string };
const ROLE_CATS = ["세일즈", "생산·재고", "마케팅", "CS"];

export default function HomeQuickLaunch() {
  // null = 아직 모름(불러오는 중 아무것도 안 그림), false = 로그인 안 됨
  const [favorites, setFavorites] = useState<Fav[] | null | false>(null);

  useEffect(() => {
    fetch("/api/b2b/favorites", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setFavorites(j?.ok ? (j.favorites || []) : false))
      .catch(() => setFavorites(false));
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

  // 역할 묶음 바로가기 — 분류의 첫 툴(관리자 전용 제외) 주소
  const roleShortcuts = useMemo(
    () => ROLE_CATS
      .map((label) => NAV.find((c) => c.label === label))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ label: c.label, tool: c.tools.find((t) => !t.adminOnly && t.href.startsWith("/")) }))
      .filter((x): x is { label: string; tool: NonNullable<typeof x.tool> } => !!x.tool),
    []
  );

  if (favorites === null || favorites === false) return null;

  // sub = 상위 툴 이름(하위 메뉴를 담았을 때) — 12px 회색으로 아래 줄. '툴 · 메뉴' 중점 결합은 2026-10-17 디자인 1차에서 없앴다.
  const Tile = ({ href, label, sub, icon }: { href: string; label: string; sub?: string | null; icon: IconName }) => (
    <Link prefetch={false} href={href} className="home-tool-card">
      <span className="sm-row" style={{ gap: 10, minWidth: 0 }}>
        <Icon name={icon} size={20} />
        <span className="sm-col" style={{ minWidth: 0 }}>
          <span className="home-tool-name sm-ellipsis" style={{ fontSize: 15 }}>{label}</span>
          {sub && <span className="home-tool-sub sm-ellipsis">{sub}</span>}
        </span>
      </span>
    </Link>
  );

  if (favorites.length === 0) {
    return (
      <section className="home-section">
        <h2 className="home-section-title">바로가기</h2>
        <div className="home-grid" style={{ marginTop: 14 }}>
          {roleShortcuts.map((s) => <Tile key={s.label} href={s.tool.href} label={s.label} icon={s.tool.icon} />)}
        </div>
      </section>
    );
  }

  return (
    <section className="home-section">
      <h2 className="home-section-title">즐겨찾는 메뉴</h2>
      <div className="home-grid" style={{ marginTop: 14 }}>
        {/* 사이드바와 동일하게 실제 메뉴 순서로 정렬 */}
        {sortByNavOrder(favorites).map((f) => { const p = navLabelParts(f.href, f.label); return <Tile key={f.href} href={f.href} label={p.main} sub={p.sub} icon={iconForHref(f.href)} />; })}
      </div>
    </section>
  );
}
