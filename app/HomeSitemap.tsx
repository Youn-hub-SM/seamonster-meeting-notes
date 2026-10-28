"use client";

// 홈 전체 메뉴 — 사이드바(NAV)와 같은 데이터로 전 메뉴를 한 화면에.
//  2026-10-14 대표 지시 "가독성 좋게": 분류마다 구역(선 + 제목) → 그 안에 툴 카드(아이콘 + 이름, 아래 하위 메뉴).
//  좁은 열에 세로로만 나열하던 이전 모양은 분류 경계가 안 보였다. 모양은 globals.css .home-map-*.
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
  const Beta = () => <span className="home-map-beta" title="베타 기능">BETA</span>;

  return (
    <section className="home-section">
      <h2 className="home-section-title">전체 메뉴</h2>
      <div className="home-map">
        {cats.map((cat) => (
          <div key={cat.label || "공통"} className="home-map-cat">
            {/* 라벨 없는 최상단 그룹(가이드·업데이트 노트·회의 정리)은 '공통'으로 */}
            <h3 className="home-map-cat-title">{cat.label || "공통"}</h3>
            <div className="home-map-tools">
              {cat.tools.map((tool) => {
                const menu = (tool.menu || []).filter((m) => !m.adminOnly || isAdmin);
                const head = (
                  <>
                    <span className="home-map-icon"><Icon name={tool.icon} size={16} /></span>
                    <span className="home-map-name">{tool.label}</span>
                    {tool.beta && <Beta />}
                    {external(tool.href) && <span className="home-map-ext" aria-hidden="true">↗</span>}
                  </>
                );
                return (
                  <div key={tool.href} className={`home-map-tool${menu.length ? " has-menu" : ""}`}>
                    {external(tool.href) ? (
                      <a href={tool.href} target="_blank" rel="noreferrer" className="home-map-tool-link">{head}</a>
                    ) : (
                      <Link prefetch={false} href={tool.href} className="home-map-tool-link">{head}</Link>
                    )}
                    {menu.length > 0 && (
                      <div className="home-map-subs">
                        {menu.map((m) => (
                          <Link prefetch={false} key={m.href} href={m.href} className="home-map-sub">{m.label}{m.beta && <Beta />}</Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
