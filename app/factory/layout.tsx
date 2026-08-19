"use client";

// 파도소리(제조사) 전용 셸 — 씨몬스터 셸(AppShell)은 /factory 하위에서 빠지고(AppShell 참조)
// 이 레이아웃이 별도 사이트처럼 파도소리 브랜드(파랑·흰 배경)로 감싼다.
// 로그인 화면(/factory/login)은 셸 없이 렌더한다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/app/components/Icon";
import "./factory.css";

const NAV = [
  { href: "/factory", label: "재고", icon: "box" as const, exact: true },
  { href: "/factory/history", label: "히스토리", icon: "receipt" as const },
  { href: "/factory/requests", label: "생산요청", icon: "factory" as const },
];

export default function FactoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/factory";
  const [userName, setUserName] = useState<string | null>(null);
  const [role, setRole] = useState<string>("factory");

  useEffect(() => { document.title = "파도소리 재고관리"; }, []);
  useEffect(() => {
    if (pathname === "/factory/login") return;
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) { setUserName(j.name || null); setRole(j.role || "internal"); } })
      .catch(() => {});
  }, [pathname]);

  if (pathname === "/factory/login") return <>{children}</>;

  async function logout() {
    await fetch("/api/b2b/auth", { method: "DELETE" });
    window.location.href = "/factory/login";
  }

  return (
    <div className="fac-theme fac-shell">
      <aside className="fac-sb">
        <Link href="/factory" className="fac-brand">
          파도소리
          <small>재고관리</small>
        </Link>
        <nav style={{ display: "flex", flexDirection: "inherit", gap: "inherit" } as React.CSSProperties}>
          {NAV.map((m) => {
            const active = m.exact ? pathname === m.href : pathname.startsWith(m.href);
            return (
              <Link key={m.href} href={m.href} className={`fac-nav-item ${active ? "is-active" : ""}`}>
                <Icon name={m.icon} />
                {m.label}
              </Link>
            );
          })}
          {/* 설정(Swit 알림)은 관리자 전용 — /factory 에 들어올 수 있는 internal = 관리자뿐 */}
          {role === "internal" && (
            <Link href="/factory/settings" className={`fac-nav-item ${pathname.startsWith("/factory/settings") ? "is-active" : ""}`}>
              <Icon name="gear" />
              설정
            </Link>
          )}
        </nav>
        <div className="fac-sb-foot">
          {userName && <span className="fac-sb-user">{userName}</span>}
          {/* 내부(씨몬스터) 계정이 들어온 경우에만 — 파도소리 계정은 어차피 미들웨어가 막는 경로다 */}
          {role === "internal" && <Link href="/">씨몬스터 도구로</Link>}
          <button type="button" onClick={logout}>로그아웃</button>
        </div>
      </aside>
      <main className="fac-main">{children}</main>
    </div>
  );
}
