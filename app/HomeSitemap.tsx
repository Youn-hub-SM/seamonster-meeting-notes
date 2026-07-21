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
        /* 최소 컬럼 210px → 모바일(347px)에선 1열이라 전부 좌측 세로 나열됐다.
           minmax 최소값을 낮춰 좁은 화면에서도 2열이 되게 함(넓은 화면은 자동으로 3~4열). */
        /* 카테고리 블록 사이 세로 간격을 넉넉히(30px) — 2열에서 뭉쳐 보이던 것 해소.
           최소 컬럼 150px → 좁은 화면 2열, 넓은 화면은 자동 3~4열. */
        .sm-map-grid { margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 30px 22px; }
        @media (max-width: 380px) { .sm-map-grid { grid-template-columns: 1fr 1fr; } }
        .sm-map-col { break-inside: avoid; }
        /* 헤더를 브랜드색으로 — 밑줄 대신 색이 각 열을 잡아준다(레퍼런스처럼). 노이즈 줄고 위계 명확. */
        .sm-map-cat { font-size: 13px; font-weight: 800; color: var(--sm-orange); letter-spacing: 0.3px; margin-bottom: 12px; }
        .sm-map-tool { margin-bottom: 11px; }
        .sm-map-tool-link { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--sm-dark); }
        .sm-map-tool-link:hover { color: var(--sm-orange); }
        .sm-map-subs { display: flex; flex-direction: column; gap: 3px; margin: 6px 0 0 22px; }
        .sm-map-sub { font-size: 12.5px; color: var(--sm-text-mid); padding: 1px 0; }
        .sm-map-sub:hover { color: var(--sm-orange); }
      `}</style>
    </section>
  );
}
