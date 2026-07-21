"use client";

// 홈 전체 사이트맵 — 사이드바(NAV)와 같은 데이터로 전 메뉴를 한 화면에.
//  NAV 배열만 바꾸면 여기도 자동 반영. 관리자 전용 분류·툴·하위메뉴는 로그인 사용자에 따라 노출.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NAV } from "./nav";
import Icon from "./components/Icon";

export default function HomeSitemap() {
  const [userName, setUserName] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setUserName(j.name); }).catch(() => {});
  }, []);
  const isAdmin = userName === "현석" || userName === "관리자";

  const cats = useMemo(
    () => NAV.filter((c) => !c.adminOnly || isAdmin).map((c) => ({
      ...c,
      tools: c.tools.filter((t) => !t.adminOnly || isAdmin),
    })).filter((c) => c.tools.length > 0),
    [isAdmin]
  );

  const external = (href: string) => /^https?:\/\//.test(href);

  return (
    <section className="home-section">
      <h2 className="home-section-title">전체 메뉴</h2>
      <div className="sm-map-grid">
        {cats.map((cat) => (
          <div key={cat.label} className="sm-map-col">
            <div className="sm-map-cat">{cat.label}</div>
            {cat.tools.map((tool) => {
              const menu = (tool.menu || []).filter((m) => !m.adminOnly || isAdmin);
              return (
                <div key={tool.href} className="sm-map-tool">
                  {external(tool.href) ? (
                    <a href={tool.href} target="_blank" rel="noreferrer" className="sm-map-tool-link">
                      <Icon name={tool.icon} size={15} /> <span>{tool.label}</span>
                    </a>
                  ) : (
                    <Link href={tool.href} className="sm-map-tool-link">
                      <Icon name={tool.icon} size={15} /> <span>{tool.label}</span>
                    </Link>
                  )}
                  {menu.length > 0 && (
                    <div className="sm-map-subs">
                      {menu.map((m) => (
                        <Link key={m.href} href={m.href} className="sm-map-sub">{m.label}</Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <style jsx>{`
        .sm-map-grid { margin-top: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 18px 20px; }
        .sm-map-col { break-inside: avoid; }
        .sm-map-cat { font-size: 12px; font-weight: 800; color: var(--sm-text-light); letter-spacing: 0.4px; padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid var(--sm-border); }
        .sm-map-tool { margin-bottom: 10px; }
        .sm-map-tool-link { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--sm-dark); }
        .sm-map-tool-link:hover { color: var(--sm-orange); }
        .sm-map-subs { display: flex; flex-direction: column; gap: 2px; margin: 5px 0 0 22px; }
        .sm-map-sub { font-size: 12.5px; color: var(--sm-text-mid); padding: 1px 0; }
        .sm-map-sub:hover { color: var(--sm-orange); }
      `}</style>
    </section>
  );
}
