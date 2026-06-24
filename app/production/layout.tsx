"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import "../b2b/b2b.css";

// 상위(전체) 앱 메뉴 — 햄버거로 접힘
const APP_MENU = [
  { href: "/", label: "홈" },
  { href: "/meeting", label: "회의 정리" },
  { href: "/correct", label: "문장 교정" },
  { href: "/cs", label: "CS 코치" },
  { href: "/utm", label: "UTM 빌더" },
  { href: "/subscription", label: "정기배송 분석" },
  { href: "/b2b", label: "B2B" },
  { href: "/production", label: "생산관리" },
];

// 생산관리 서브 메뉴
const PROD_MENU = [
  { href: "/production", label: "생산일정" },
  { href: "/production/sku", label: "SKU 생성기" },
  { href: "/production/products", label: "품목 업로드" },
];

export default function ProductionLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [userName, setUserName] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [gitbook, setGitbook] = useState("");

  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setUserName(j.name); })
      .catch(() => {});
    fetch("/api/links", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok && j.gitbook) setGitbook(j.gitbook); })
      .catch(() => {});
  }, []);

  useEffect(() => { setMenuOpen(false); }, [pathname]);

  async function handleLogout() {
    await fetch("/api/b2b/auth", { method: "DELETE" });
    router.push("/b2b/login");
    router.refresh();
  }

  const isActive = (href: string) =>
    href === "/production" ? pathname === "/production" : pathname.startsWith(href);

  return (
    <div className="b2b-shell">
      <nav className="b2b-subnav">
        <div className="b2b-subnav-inner">
          <div className="b2b-nav-left">
            <button
              type="button"
              className="b2b-appmenu-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="전체 메뉴"
              aria-expanded={menuOpen}
            >
              ☰
            </button>
            <Link href="/" className="b2b-brand" title="내부도구 홈">씨몬스터</Link>
            <span className="b2b-brand-sub">생산관리</span>
          </div>

          <div className="b2b-nav-links">
            {PROD_MENU.map((m) => (
              <Link
                key={m.href}
                href={m.href}
                className={`b2b-subnav-link ${isActive(m.href) ? "is-active" : ""}`}
              >
                {m.label}
              </Link>
            ))}
            {gitbook && (
              <a href={gitbook} target="_blank" rel="noopener noreferrer" className="b2b-subnav-link">
                가이드라인 ↗
              </a>
            )}
          </div>

          <div className="b2b-nav-right">
            {userName && <span className="b2b-nav-user" title="현재 로그인 사용자">{userName}</span>}
            <button type="button" onClick={handleLogout} className="b2b-subnav-link b2b-logout-btn" title="로그아웃">
              로그아웃
            </button>
          </div>
        </div>

        {menuOpen && (
          <>
            <div className="b2b-appmenu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="b2b-appmenu">
              <div className="b2b-appmenu-title">전체 메뉴</div>
              {APP_MENU.map((m) => (
                <Link
                  key={m.href}
                  href={m.href}
                  className={`b2b-appmenu-link ${m.href === "/production" ? "is-current" : ""}`}
                  onClick={() => setMenuOpen(false)}
                >
                  {m.label}
                </Link>
              ))}
            </div>
          </>
        )}
      </nav>

      <main className="b2b-main">{children}</main>
    </div>
  );
}
