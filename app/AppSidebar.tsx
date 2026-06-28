"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { NAV, HOME, type NavTool } from "./nav";

function toolActive(href: string, pathname: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
function itemActive(href: string, toolHref: string, pathname: string) {
  if (href === toolHref) return pathname === href; // 인덱스 메뉴는 정확히 일치할 때만
  return pathname === href || pathname.startsWith(href + "/");
}

export default function AppSidebar({ open, onNavigate }: { open: boolean; onNavigate?: () => void }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);

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
    const active = toolActive(t.href, pathname);
    const menu = (t.menu || []).filter((m) => !m.adminOnly || isAdmin);
    return (
      <div key={t.href}>
        <Link href={t.href} className={`app-sb-tool ${active ? "is-active" : ""}`} onClick={onNavigate}>
          <span className="app-sb-emoji">{t.emoji}</span>
          <span>{t.label}</span>
        </Link>
        {active && menu.length > 0 && (
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
        <Link href="/" className={`app-sb-tool ${pathname === "/" ? "is-active" : ""}`} onClick={onNavigate}>
          <span className="app-sb-emoji">{HOME.emoji}</span>
          <span>{HOME.label}</span>
        </Link>
        {NAV.map((cat) => (
          <div key={cat.label} className="app-sb-group">
            <div className="app-sb-cat">{cat.label}</div>
            {cat.tools.map(renderTool)}
          </div>
        ))}
      </nav>

      {userName && (
        <div className="app-sb-foot">
          <span className="app-sb-username" title="현재 로그인 사용자">👤 {userName}</span>
          <button type="button" className="app-sb-logout" onClick={handleLogout}>로그아웃</button>
        </div>
      )}
    </aside>
  );
}
