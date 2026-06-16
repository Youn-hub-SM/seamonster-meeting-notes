"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import "./b2b.css";
import ActivityFeed from "./ActivityFeed";

export default function B2BLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [userName, setUserName] = useState<string | null>(null);

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

  async function handleLogout() {
    await fetch("/api/b2b/auth", { method: "DELETE" });
    router.push("/b2b/login");
    router.refresh();
  }

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
          <Link href="/b2b" className="b2b-subnav-link">대시보드</Link>
          <Link href="/b2b/orders" className="b2b-subnav-link">발주</Link>
          <Link href="/b2b/companies" className="b2b-subnav-link">업체 주소록</Link>
          <Link href="/b2b/products" className="b2b-subnav-link">원가표</Link>
          <Link href="/b2b/margin" className="b2b-subnav-link">이익률</Link>
          <Link href="/b2b/reports" className="b2b-subnav-link">매출 집계</Link>
          <Link href="/b2b/payments" className="b2b-subnav-link">입금 확인</Link>
          <Link href="/b2b/history" className="b2b-subnav-link">히스토리</Link>
          {userName && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--sm-text-mid)",
                whiteSpace: "nowrap",
                alignSelf: "center",
              }}
              title="현재 로그인 사용자"
            >
              {userName}
            </span>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="b2b-subnav-link"
            style={{
              marginLeft: userName ? 0 : "auto",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              color: "var(--sm-text-light)",
            }}
            title="로그아웃"
          >
            로그아웃
          </button>
        </div>
      </nav>

      <div className="b2b-layout">
        <main className="b2b-main b2b-main--with-feed">{children}</main>
        <ActivityFeed />
      </div>
    </div>
  );
}
