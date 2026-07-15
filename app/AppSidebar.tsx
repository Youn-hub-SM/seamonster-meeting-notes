"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { NAV, HOME, type NavTool } from "./nav";
import Icon, { type IconName } from "./components/Icon";

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

export default function AppSidebar({ open, collapsed, onToggleCollapse, onNavigate }: { open: boolean; collapsed?: boolean; onToggleCollapse?: () => void; onNavigate?: () => void }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<{ href: string; label: string }[]>([]);
  const [editFav, setEditFav] = useState(false);
  // 즐겨찾기 아코디언 — 기본 펼침, 상태는 사이드바 접기(sb_collapsed)와 같은 방식으로 기억
  const [favOpen, setFavOpen] = useState(true);
  useEffect(() => { try { setFavOpen(localStorage.getItem("sb_fav_open") !== "0"); } catch {} }, []);
  function toggleFavOpen() {
    setFavOpen((v) => {
      const next = !v;
      try { localStorage.setItem("sb_fav_open", next ? "1" : "0"); } catch {}
      return next;
    });
  }
  // 아코디언: 여러 개를 동시에 펼칠 수 있음(단일 열림 아님). 활성 툴은 자동으로 펼치되, 열어둔 다른 건 닫지 않음.
  const activeMenuHref = useMemo(() => {
    for (const cat of NAV) for (const t of cat.tools) if (t.menu?.length && toolActive(t, pathname)) return t.href;
    return null;
  }, [pathname]);
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  const skipAutoOpen = useRef(false); // 즐겨찾기로 이동 시 활성 아코디언 자동펼침 억제
  const isToolOpen = (href: string) => openSet.has(href);
  // 클릭: 열려 있으면 닫고, 아니면 펼침(나머지는 그대로 유지).
  const toggleTool = (href: string) => setOpenSet((s) => { const n = new Set(s); if (n.has(href)) n.delete(href); else n.add(href); return n; });
  // 현재 경로의 활성 툴은 자동으로 펼쳐 둠(다른 아코디언은 접지 않음). 단, 즐겨찾기로 이동했으면 억제.
  useEffect(() => {
    if (skipAutoOpen.current) { skipAutoOpen.current = false; return; }
    if (activeMenuHref) setOpenSet((s) => (s.has(activeMenuHref) ? s : new Set(s).add(activeMenuHref)));
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // 로그인 사용자(있으면) — 설정 메뉴 노출 + 푸터 표시용. /api/b2b/auth 는 미들웨어 예외라 어디서나 호출 가능.
  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setUserName(j?.ok ? j.name || null : null))
      .catch(() => {});
  }, [pathname]);

  const isAdmin = userName === "현석" || userName === "관리자";

  // 즐겨찾기 항목 아이콘: href → 해당 툴(또는 상위 툴)의 실제 아이콘. (기존 대체)
  const iconForHref = useMemo(() => {
    const m = new Map<string, IconName>();
    for (const cat of NAV) for (const t of cat.tools) {
      m.set(t.href, t.icon);
      for (const sub of t.menu || []) if (!m.has(sub.href)) m.set(sub.href, t.icon);
    }
    return (href: string): IconName => m.get(href) || "home";
  }, []);

  // 즐겨찾기(아이디별) 로드 — 로그인 사용자 기준
  useEffect(() => {
    if (!userName) { setFavorites([]); setEditFav(false); return; }
    fetch("/api/b2b/favorites", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setFavorites(j.favorites || []); }).catch(() => {});
  }, [userName]);

  const isFav = (href: string) => favorites.some((f) => f.href === href);
  async function toggleFav(href: string, label: string) {
    const on = !isFav(href);
    setFavorites((prev) => (on ? [...prev, { href, label }] : prev.filter((f) => f.href !== href))); // 낙관적
    try {
      const j = await (await fetch("/api/b2b/favorites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ href, label, on }) })).json();
      if (j?.ok) setFavorites(j.favorites || []);
    } catch { /* 실패 시 다음 로드에서 정정 */ }
  }
  const FavToggle = ({ href, label }: { href: string; label: string }) => (
    <button type="button" className="app-sb-favstar" aria-label={isFav(href) ? "즐겨찾기 해제" : "즐겨찾기 추가"} title={isFav(href) ? "즐겨찾기 해제" : "즐겨찾기 추가"}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(href, label); }}
      style={{ marginLeft: "auto", flex: "0 0 auto", background: "none", border: "none", cursor: "pointer", color: isFav(href) ? "var(--sm-orange)" : "var(--sm-text-light)", fontSize: 16, lineHeight: 1, padding: "0 6px" }}>
      {isFav(href) ? "✕" : "＋"}
    </button>
  );

  async function handleLogout() {
    await fetch("/api/b2b/auth", { method: "DELETE" });
    router.push("/b2b/login");
    router.refresh();
  }

  function renderTool(t: NavTool) {
    const active = toolActive(t, pathname);
    // 접힘(아이콘만): 하위 메뉴가 있어도 아코디언 대신 대표 페이지로 바로 이동, 라벨은 툴팁.
    if (collapsed) {
      const external = /^https?:\/\//.test(t.href);
      const inner = <span className="app-sb-emoji"><Icon name={t.icon} /></span>;
      return (
        <div key={t.href} className={`app-sb-tool-row ${active ? "is-active" : ""}`}>
          {external ? (
            <a href={t.href} target="_blank" rel="noreferrer" className="app-sb-tool" title={t.label} aria-label={t.label} onClick={onNavigate}>{inner}</a>
          ) : (
            <Link href={t.href} className="app-sb-tool" title={t.label} aria-label={t.label} onClick={onNavigate}>{inner}</Link>
          )}
        </div>
      );
    }
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
          {editFav && !hasMenu && <FavToggle href={t.href} label={t.label} />}
        </div>
        {expanded && (
          <div className="app-sb-menu">
            {menu.map((m) => editFav ? (
              <div key={m.href} className="app-sb-menu-row" style={{ display: "flex", alignItems: "center" }}>
                <Link href={m.href} className={`app-sb-menu-item ${itemActive(m.href, t.href, pathname) ? "is-active" : ""}`} style={{ flex: 1 }} onClick={onNavigate}>{m.label}</Link>
                <FavToggle href={m.href} label={`${t.label} · ${m.label}`} />
              </div>
            ) : (
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
      <div className="app-sb-head">
        <Link href="/" className="app-sb-brand" onClick={onNavigate}>씨몬스터</Link>
        {onToggleCollapse && (
          <button type="button" className="app-sb-collapse" onClick={onToggleCollapse}
            aria-label={collapsed ? "메뉴 펼치기" : "메뉴 접기"} title={collapsed ? "메뉴 펼치기" : "메뉴 접기"}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      <nav className="app-sb-nav">
        <div className={`app-sb-tool-row ${pathname === "/" ? "is-active" : ""}`}>
          <Link href="/" className="app-sb-tool" title={HOME.label} aria-label={HOME.label} onClick={onNavigate}>
            <span className="app-sb-emoji"><Icon name={HOME.icon} /></span>
            <span className="app-sb-tool-label">{HOME.label}</span>
          </Link>
        </div>

        {/* 즐겨찾는 메뉴 (아이디별). 편집 모드에서만 담기(＋)/빼기(✕) 버튼이 나타남 */}
        {!collapsed && userName && (
          <div className="app-sb-group">
            <div className="app-sb-cat" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" className="app-sb-cat-toggle" onClick={toggleFavOpen} aria-expanded={favOpen}>
                즐겨찾는 메뉴
              </button>
              <button type="button" onClick={() => { setEditFav((v) => !v); if (!favOpen) toggleFavOpen(); }}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, padding: 0, color: editFav ? "var(--sm-orange)" : "var(--sm-text-light)" }}>
                {editFav ? "완료" : "편집"}
              </button>
              <button
                type="button"
                className={`app-sb-chev ${favOpen ? "is-open" : ""}`}
                aria-label={favOpen ? "즐겨찾는 메뉴 접기" : "즐겨찾는 메뉴 펼치기"}
                aria-expanded={favOpen}
                onClick={toggleFavOpen}
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path d="M5.5 3.5L10 8l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            {favOpen && (favorites.length === 0 ? (
              <div className="sm-faint" style={{ fontSize: 11, padding: "2px 12px 4px", lineHeight: 1.5 }}>
                {editFav ? "메뉴 옆 ＋를 눌러 담으세요" : "‘편집’을 눌러 자주 쓰는 메뉴를 담으세요"}
              </div>
            ) : favorites.map((f) => (
              <div key={f.href} className={`app-sb-tool-row ${pathname === f.href || pathname.startsWith(f.href + "/") ? "is-active" : ""}`}>
                <Link href={f.href} className="app-sb-tool" onClick={() => { skipAutoOpen.current = true; onNavigate?.(); }}>
                  <span className="app-sb-emoji"><Icon name={iconForHref(f.href)} /></span>
                  <span className="app-sb-tool-label">{f.label}</span>
                </Link>
                {editFav && <FavToggle href={f.href} label={f.label} />}
              </div>
            )))}
          </div>
        )}

        {/* 카테고리 목록만 스크롤 — 브랜드·홈·즐겨찾기(위)와 로그아웃(아래)은 항상 보임 */}
        <div className="app-sb-scroll">
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
        </div>
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
