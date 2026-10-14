"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { NAV, sortByNavOrder, navLabelOf, navHrefActive, type NavTool, type NavMenuItem } from "./nav";
import Icon, { type IconName } from "./components/Icon";
import { countNewUpdates, markUpdatesSeen, readUpdatesSeenAt } from "./lib/updates-seen";

// '최근'(2026-10-14 C4) — 이 브라우저에서 마지막으로 연 화면. NAV 의 툴·하위 메뉴 주소와 정확히 일치할 때만 기록한다
//  (홈·사용 가이드·업데이트 노트·외부 링크 제외). 저장은 10개, 화면엔 즐겨찾기에 없는 것 5개.
const RECENT_KEY = "sb_recent";
const RECENT_KEEP = 10;
const RECENT_SHOW = 5;
const RECENT_SKIP = new Set(["/", "/guide", "/updates"]);
const RECENT_HREFS: Set<string> = (() => {
  const s = new Set<string>();
  for (const cat of NAV) for (const t of cat.tools) {
    if (t.href.startsWith("/") && !RECENT_SKIP.has(t.href)) s.add(t.href);
    for (const sub of t.menu || []) if (sub.href.startsWith("/") && !RECENT_SKIP.has(sub.href)) s.add(sub.href);
  }
  return s;
})();
function readRecent(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && RECENT_HREFS.has(x)) : [];
  } catch { return []; }
}

function itemActive(m: NavMenuItem, toolHref: string, pathname: string) {
  if (m.exact || m.href === toolHref) return pathname === m.href; // 인덱스·exact 메뉴는 정확히 일치할 때만
  return pathname === m.href || pathname.startsWith(m.href + "/");
}
// 툴 활성 판정. 메뉴가 있으면 '하위 메뉴에 해당할 때만' 활성 — /production/sku 같이 URL
//  접두어만 겹치는 독립 툴 때문에 부모(재고/생산 관리)까지 주황색으로 켜지던 버그 방지.
function toolActive(t: NavTool, pathname: string) {
  if (t.href === "/") return pathname === "/";
  const menu = t.menu || [];
  if (menu.length) return menu.some((m) => itemActive(m, t.href, pathname));
  if (t.exact) return pathname === t.href;
  return pathname === t.href || pathname.startsWith(t.href + "/");
}

export default function AppSidebar({ open, collapsed, onToggleCollapse, onNavigate }: { open: boolean; collapsed?: boolean; onToggleCollapse?: () => void; onNavigate?: () => void }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  const [role, setRole] = useState<string>("internal");
  // 고정 끄기(collapsed) 상태에서 마우스 오버 시 임시 펼침. 고정을 끄는 순간에도
  //  포인터가 안에 있으므로 바로 레일로 줄지 않고, 마우스가 떠날 때 접힌다.
  const [hovering, setHovering] = useState(false);
  const rail = !!collapsed && !hovering; // 접힌 띠(» 버튼만) 렌더 여부 — 메뉴는 아예 렌더하지 않는다(호버 펼침 중엔 전체 메뉴 렌더)
  const [favorites, setFavorites] = useState<{ href: string; label: string }[]>([]);
  const [editFav, setEditFav] = useState(false);
  // 최근 사용(C4) + 새 업데이트 수(D2) — 둘 다 이 브라우저(localStorage) 기준. 경로가 바뀔 때마다 갱신.
  const [recent, setRecent] = useState<string[]>([]);
  const [newUpdates, setNewUpdates] = useState(0);
  useEffect(() => {
    if (pathname === "/updates") markUpdatesSeen(); // 업데이트 노트에 들어오면 '본 시각' 갱신 → 배지 0
    setNewUpdates(countNewUpdates(readUpdatesSeenAt()));
    if (RECENT_HREFS.has(pathname)) {
      const next = [pathname, ...readRecent().filter((h) => h !== pathname)].slice(0, RECENT_KEEP);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
      setRecent(next);
    } else {
      setRecent(readRecent());
    }
  }, [pathname]);
  // '베타 테스트 중' 접이식 분류는 2026-10-14 C6 으로 해체 — 베타 항목은 각 분류 안에 BETA 배지(nav.ts beta)로 표시.
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
      .then((j) => { setUserName(j?.ok ? j.name || null : null); setRole(j?.ok ? j.role || "internal" : "internal"); })
      .catch(() => {});
  }, [pathname]);

  const isAdmin = userName === "현석" || userName === "관리자";
  // 파도소리 계정은 /factory 만 접근 가능(미들웨어가 차단) — 사이드바도 그 툴만 남긴다.
  //  숨김은 보안이 아니라 표시 문제다. 되돌아오는 죽은 링크를 안 보여주기 위한 것.
  const isFactoryUser = role === "factory";

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

  // 표시 순서 = 실제 메뉴 순서(대분류 → 툴 → 하위 메뉴). 담은 순서는 저장만 하고 화면에선 항상 이 순서.
  const sortedFavorites = useMemo(() => sortByNavOrder(favorites), [favorites]);

  const isFav = (href: string) => favorites.some((f) => f.href === href);
  // 화면에 보일 최근 — 즐겨찾기에 이미 있는 항목은 뺀다(같은 행이 두 번 보이지 않게)
  const recentShown = useMemo(() => recent.filter((h) => !favorites.some((f) => f.href === h)).slice(0, RECENT_SHOW), [recent, favorites]);
  async function toggleFav(href: string, label: string) {
    const on = !isFav(href);
    setFavorites((prev) => (on ? [...prev, { href, label }] : prev.filter((f) => f.href !== href))); // 낙관적
    try {
      const j = await (await fetch("/api/b2b/favorites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ href, label, on }) })).json();
      if (j?.ok) setFavorites(j.favorites || []);
    } catch { /* 실패 시 다음 로드에서 정정 */ }
  }
  // 대상 크기 24px 이상(WCAG 2.5.8) — 모양은 .app-sb-favstar(globals.css)
  const FavToggle = ({ href, label }: { href: string; label: string }) => (
    <button type="button" className={`app-sb-favstar ${isFav(href) ? "is-on" : ""}`} aria-label={isFav(href) ? "즐겨찾기 해제" : "즐겨찾기 추가"} title={isFav(href) ? "즐겨찾기 해제" : "즐겨찾기 추가"}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(href, label); }}>
      {isFav(href) ? "✕" : "＋"}
    </button>
  );
  const Beta = () => <span className="app-sb-beta" title="베타 기능">BETA</span>;

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
            // 라벨 클릭 = 대표 페이지 이동(+접혀 있으면 펼침) — 매일 첫 진입 2클릭→1클릭(2026-08-28 대표 확정). 접기는 우측 화살표.
            <Link href={t.href} className="app-sb-tool" aria-expanded={expanded} onClick={() => { if (!expanded) toggleTool(t.href); onNavigate?.(); }}>
              <span className="app-sb-emoji"><Icon name={t.icon} /></span>
              <span className="app-sb-tool-label">{t.label}</span>
              {t.beta && <Beta />}
            </Link>
          ) : /^https?:\/\//.test(t.href) ? (
            // 외부 링크(가이드 등)는 새 탭으로
            <a href={t.href} target="_blank" rel="noreferrer" className="app-sb-tool" onClick={onNavigate}>
              <span className="app-sb-emoji"><Icon name={t.icon} /></span>
              <span className="app-sb-tool-label">{t.label}</span>
              {t.beta && <Beta />}
              <span className="app-sb-ext" aria-hidden="true">↗</span>
            </a>
          ) : (
            <Link href={t.href} className="app-sb-tool" onClick={onNavigate}>
              <span className="app-sb-emoji"><Icon name={t.icon} /></span>
              <span className="app-sb-tool-label">{t.label}</span>
              {t.beta && <Beta />}
              {/* 새 업데이트 수(D2) — 업데이트 노트 행에만, 0이면 없음 */}
              {t.href === "/updates" && newUpdates > 0 && <span className="app-sb-count" title={`새 업데이트 ${newUpdates}건`}>{newUpdates}</span>}
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
              <div key={m.href} className="app-sb-menu-row">
                <Link href={m.href} className={`app-sb-menu-item ${itemActive(m, t.href, pathname) ? "is-active" : ""}`} onClick={onNavigate}>{m.label}{m.beta && <Beta />}</Link>
                <FavToggle href={m.href} label={`${t.label} · ${m.label}`} />
              </div>
            ) : (
              <Link
                key={m.href}
                href={m.href}
                className={`app-sb-menu-item ${itemActive(m, t.href, pathname) ? "is-active" : ""}`}
                onClick={onNavigate}
              >
                {m.label}{m.beta && <Beta />}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      className={`app-sidebar ${open ? "is-open" : ""} ${collapsed && hovering ? "is-hover-open" : ""}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="app-sb-head">
        {onToggleCollapse && (
          // 접기 « / 펼치기 » — 햄버거는 '메뉴'로 읽혀 접기 기능이 안 보였다(2026-10-14). 접힌 상태엔 이 버튼만 남고 메뉴·아이콘은 없다(마우스를 올리면 펼쳐진다).
          <button type="button" className="app-sb-collapse" onClick={onToggleCollapse}
            aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"} title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              {collapsed
                ? <path d="M3 3.5L7.5 8 3 12.5M8.5 3.5L13 8l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M13 3.5L8.5 8l4.5 4.5M7.5 3.5L3 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        )}
        {/* 이제 홈으로 가는 유일한 입구 — 파도소리 계정에게 '/' 는 막힌 경로라 자기 홈으로 보낸다 */}
        <Link href={isFactoryUser ? "/factory" : "/"} className="app-sb-brand" onClick={onNavigate}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="씨몬스터" style={{ height: 22, width: "auto", display: "block" }} />
        </Link>
      </div>

      {!rail && <nav className="app-sb-nav">
        {/* 홈 버튼은 없앴다 — 위 로고가 곧 홈 링크라 같은 곳으로 가는 버튼이 둘이었다.
            즐겨찾기는 파도소리 계정에겐 막힌 경로라 계속 감춘다. */}
        {/* 즐겨찾는 메뉴 (아이디별). 편집 모드에서만 담기(＋)/빼기(✕) 버튼이 나타남 */}
        {userName && !isFactoryUser && (
          <div className="app-sb-group app-sb-fav">
            <div className="app-sb-cat app-sb-cat-row">
              <button type="button" className="app-sb-cat-toggle" onClick={toggleFavOpen} aria-expanded={favOpen}>
                즐겨찾는 메뉴
              </button>
              <button type="button" className={`app-sb-fav-edit ${editFav ? "is-on" : ""}`} onClick={() => { setEditFav((v) => !v); if (!favOpen) toggleFavOpen(); }}>
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
            {favOpen && sortedFavorites.map((f) => (
              <div key={f.href} className={`app-sb-tool-row ${navHrefActive(f.href, pathname) ? "is-active" : ""}`}>
                <Link href={f.href} className="app-sb-tool" onClick={() => { skipAutoOpen.current = true; onNavigate?.(); }}>
                  <span className="app-sb-emoji"><Icon name={iconForHref(f.href)} /></span>
                  <span className="app-sb-tool-label">{navLabelOf(f.href, f.label)}</span>
                </Link>
                {editFav && <FavToggle href={f.href} label={f.label} />}
              </div>
            ))}
          </div>
        )}

        {/* 카테고리 목록만 스크롤 — 브랜드·홈·즐겨찾기(위)와 로그아웃(아래)은 항상 보임 */}
        <div className="app-sb-scroll">
          {/* 최근(C4) — 즐겨찾기 바로 아래, 스크롤 구역 맨 위. 비어 있으면 섹션 자체를 그리지 않는다. 편집 모드 없음 */}
          {userName && !isFactoryUser && recentShown.length > 0 && (
            <div className="app-sb-group app-sb-recent">
              <div className="app-sb-cat">최근</div>
              {recentShown.map((href) => (
                <div key={href} className={`app-sb-tool-row ${navHrefActive(href, pathname) ? "is-active" : ""}`}>
                  <Link href={href} className="app-sb-tool" onClick={() => { skipAutoOpen.current = true; onNavigate?.(); }}>
                    <span className="app-sb-emoji"><Icon name={iconForHref(href)} /></span>
                    <span className="app-sb-tool-label">{navLabelOf(href, href)}</span>
                  </Link>
                </div>
              ))}
            </div>
          )}
          {NAV.filter((cat) => !cat.adminOnly || isAdmin).map((cat) => {
            const tools = cat.tools
              .filter((t) => !t.adminOnly || isAdmin)
              .filter((t) => !isFactoryUser || t.href.startsWith("/factory"));
            if (tools.length === 0) return null;
            return (
              <div key={cat.label} className="app-sb-group">
                {cat.label ? (
                  <div className="app-sb-cat">{cat.label}</div>
                ) : null /* 라벨 없는 최상단 그룹(사용 가이드·업데이트 노트)은 제목 없이 툴만 */}
                {tools.map(renderTool)}
              </div>
            );
          })}
        </div>
      </nav>}

      {!rail && userName && (
        <div className="app-sb-foot">
          <span className="app-sb-username" title="현재 로그인 사용자"><Icon name="user" size={14} /> {userName}</span>
          <button type="button" className="app-sb-logout" onClick={handleLogout}>로그아웃</button>
        </div>
      )}
    </aside>
  );
}
