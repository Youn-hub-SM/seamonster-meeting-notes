"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { NAV, HOME, type NavTool } from "./nav";
import Icon from "./components/Icon";

function itemActive(href: string, toolHref: string, pathname: string) {
  if (href === toolHref) return pathname === href; // 인덱스 메뉴는 정확히 일치할 때만
  return pathname === href || pathname.startsWith(href + "/");
}
// 툴 활성 판정. 메뉴가 있으면 '하위 메뉴에 해당할 때만' 활성 — /production/sku 같이 URL
//  접두어만 겹치는 독립 툴 때문에 부모(생산 관리)까지 주황색으로 켜지던 버그 방지.
function toolActive(t: NavTool, pathname: string) {
  if (t.href === "/") return pathname === "/";
  const menu = t.menu || [];
  if (menu.length) return menu.some((m) => itemActive(m.href, t.href, pathname));
  return pathname === t.href || pathname.startsWith(t.href + "/");
}

export default function AppSidebar({ open, onNavigate }: { open: boolean; onNavigate?: () => void }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  // 아코디언: 한 번에 하나만 펼침. 미조작(undefined)이면 현재 경로의 활성 메뉴 툴을 기본 펼침.
  const activeMenuHref = useMemo(() => {
    for (const cat of NAV) for (const t of cat.tools) if (t.menu?.length && toolActive(t, pathname)) return t.href;
    return null;
  }, [pathname]);
  const [openHref, setOpenHref] = useState<string | null | undefined>(undefined);
  const effectiveOpen = openHref === undefined ? activeMenuHref : openHref;
  const isToolOpen = (href: string) => effectiveOpen === href;
  // 열려 있으면 닫고, 아니면 그것만 열기(나머지 아코디언은 닫힘).
  const toggleTool = (href: string) => setOpenHref((cur) => ((cur === undefined ? activeMenuHref : cur) === href ? null : href));
  // 다른 메뉴(경로)로 이동하면 수동으로 펼쳐둔 아코디언은 접고 현재 위치 기준으로 복귀.
  useEffect(() => { setOpenHref(undefined); }, [pathname]);

  // 로그인 사용자(있으면) — 설정 메뉴 노출 + 푸터 표시용. /api/b2b/auth 는 미들웨어 예외라 어디서나 호출 가능.
  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setUserName(j?.ok ? j.name || null : null))
      .catch(() => {});
  }, [pathname]);

  const isAdmin = userName === "현석" || userName === "관리자";

  async function handleLogout() {
    await fetch("/api/b2b/auth", { method: "DELETE" });
    router.push("/b2b/login");
    router.refresh();
  }

  function renderTool(t: NavTool) {
    const active = toolActive(t, pathname);
    const menu = (t.menu || []).filter((m) => !m.adminOnly || isAdmin);
    const hasMenu = menu.length > 0;
    const expanded = hasMenu && isToolOpen(t.href);
    return (
      <div key={t.href}>
        <div className={`app-sb-tool-row ${active ? "is-active" : ""}`}>
          {hasMenu ? (
            // 하위 메뉴 있는 툴: 클릭해도 이동하지 않고 펼침/접힘만(이동은 하위 메뉴에서).
            <button type="button" className="app-sb-tool" aria-expanded={expanded} onClick={() => toggleTool(t.href)}>
              <span className="app-sb-emoji"><Icon name={t.icon} /></span>
              <span className="app-sb-tool-label">{t.label}</span>
            </button>
          ) : /^https?:\/\//.test(t.href) ? (
            // 외부 링크(가이드 등)는 새 탭으로
            <a href={t.href} target="_blank" rel="noreferrer" className="app-sb-tool" onClick={onNavigate}>
              <span className="app-sb-emoji"><Icon name={t.icon} /></span>
              <span className="app-sb-tool-label">{t.label}</span>
              <span aria-hidden="true" style={{ marginLeft: "auto", fontSize: 11, color: "var(--sm-text-light)" }}>↗</span>
            </a>
          ) : (
            <Link href={t.href} className="app-sb-tool" onClick={onNavigate}>
              <span className="app-sb-emoji"><Icon name={t.icon} /></span>
              <span className="app-sb-tool-label">{t.label}</span>
            </Link>
          )}
          {hasMenu && (
            <button
              type="button"
              className={`app-sb-chev ${expanded ? "is-open" : ""}`}
              aria-label={expanded ? `${t.label} 메뉴 접기` : `${t.label} 메뉴 펼치기`}
              aria-expanded={expanded}
              onClick={() => toggleTool(t.href)}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path d="M5.5 3.5L10 8l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        {expanded && (
          <div className="app-sb-menu">
            {menu.map((m) => (
              <Link
                key={m.href}
                href={m.href}
                className={`app-sb-menu-item ${itemActive(m.href, t.href, pathname) ? "is-active" : ""}`}
                onClick={onNavigate}
              >
                {m.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className={`app-sidebar ${open ? "is-open" : ""}`}>
      <Link href="/" className="app-sb-brand" onClick={onNavigate}>씨몬스터</Link>

      <nav className="app-sb-nav">
        <div className={`app-sb-tool-row ${pathname === "/" ? "is-active" : ""}`}>
          <Link href="/" className="app-sb-tool" onClick={onNavigate}>
            <span className="app-sb-emoji"><Icon name={HOME.icon} /></span>
            <span className="app-sb-tool-label">{HOME.label}</span>
          </Link>
        </div>
        {NAV.filter((cat) => !cat.adminOnly || isAdmin).map((cat) => {
          const tools = cat.tools.filter((t) => !t.adminOnly || isAdmin);
          if (tools.length === 0) return null;
          return (
            <div key={cat.label} className="app-sb-group">
              <div className="app-sb-cat">{cat.label}</div>
              {tools.map(renderTool)}
            </div>
          );
        })}
      </nav>

      {userName && (
        <div className="app-sb-foot">
          <span className="app-sb-username" title="현재 로그인 사용자"><Icon name="user" size={14} /> {userName}</span>
          <button type="button" className="app-sb-logout" onClick={handleLogout}>로그아웃</button>
        </div>
      )}
    </aside>
  );
}
