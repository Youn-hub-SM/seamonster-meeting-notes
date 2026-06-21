"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import "./b2b.css";
import ActivityFeed from "./ActivityFeed";

// 상위(전체) 앱 메뉴 — 햄버거로 접힘
const APP_MENU = [
  { href: "/", label: "회의 정리" },
  { href: "/correct", label: "문장 교정" },
  { href: "/cs", label: "CS 답변" },
  { href: "/utm", label: "UTM 빌더" },
  { href: "/subscription", label: "정기배송 분석" },
  { href: "/b2b", label: "B2B" },
];

// B2B 서브 메뉴 (한 줄 바)
const B2B_MENU = [
  { href: "/b2b", label: "대시보드" },
  { href: "/b2b/orders", label: "발주" },
  { href: "/b2b/companies", label: "업체 주소록" },
  { href: "/b2b/products", label: "원가표" },
  { href: "/b2b/margin", label: "이익률" },
  { href: "/b2b/reports", label: "매출 집계" },
  { href: "/b2b/payments", label: "입금 확인" },
  { href: "/b2b/history", label: "히스토리" },
  { href: "/b2b/settings", label: "설정" },
];

export default function B2BLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [userName, setUserName] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // 로그인 페이지에서는 서브 네비·활동 피드를 숨김 (인증 전)
  const hideChrome = pathname === "/b2b/login";

  // 현재 로그인 사용자 이름 (비밀번호로 구분: 지인/예지/현석/관리자)
  useEffect(() => {
    if (hideChrome) return;
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setUserName(j.name); })
      .catch(() => {});
  }, [hideChrome]);

  // 경로 바뀌면 햄버거 메뉴 닫기
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  async function handleLogout() {
    await fetch("/api/b2b/auth", { method: "DELETE" });
    router.push("/b2b/login");
    router.refresh();
  }

  const isActive = (href: string) => (href === "/b2b" ? pathname === "/b2b" : pathname.startsWith(href));

  if (hideChrome) {
    return (
      <div className="b2b-shell">
        <main className="b2b-main">{children}</main>
      </div>
    );
  }

  return (
    <div className="b2b-shell">
      <nav className="b2b-subnav">
        <div className="b2b-subnav-inner">
          {/* 좌측: 햄버거(전체 메뉴) + 브랜드 */}
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
            <Link href="/b2b" className="b2b-brand">씨몬스터</Link>
          </div>

          {/* 가운데: B2B 메뉴 (모바일에서 가로 스크롤) */}
          <div className="b2b-nav-links">
            {B2B_MENU.map((m) => (
              <Link
                key={m.href}
                href={m.href}
                className={`b2b-subnav-link ${isActive(m.href) ? "is-active" : ""}`}
              >
                {m.label}
              </Link>
            ))}
          </div>

          {/* 우측: 사용자 + 최근 변경 + 로그아웃 */}
          <div className="b2b-nav-right">
            {userName && <span className="b2b-nav-user" title="현재 로그인 사용자">{userName}</span>}
            <ActivityFeed />
            <button type="button" onClick={handleLogout} className="b2b-subnav-link b2b-logout-btn" title="로그아웃">
              로그아웃
            </button>
          </div>
        </div>

        {/* 햄버거 = 전체 앱 메뉴 드롭다운 */}
        {menuOpen && (
          <>
            <div className="b2b-appmenu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="b2b-appmenu">
              <div className="b2b-appmenu-title">전체 메뉴</div>
              {APP_MENU.map((m) => (
                <Link
                  key={m.href}
                  href={m.href}
                  className={`b2b-appmenu-link ${m.href === "/b2b" ? "is-current" : ""}`}
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
