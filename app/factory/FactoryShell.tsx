"use client";

// 파도소리(제조사) 전용 셸 — 씨몬스터 셸(AppShell)은 /factory 하위에서 빠지고(AppShell 참조)
// 이 셸이 별도 사이트처럼 파도소리 브랜드(파랑·흰 배경)로 감싼다(layout.tsx 가 감싸 부른다 — 제목·아이콘은 거기서).
// 로그인 화면(/factory/login)은 셸 없이 렌더한다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/app/components/Icon";
import "./factory.css";

// 상품마스터는 파도소리 계정에게도 보인다(2026-10-20 대표 지시 — 전엔 관리자 전용).
//  /factory 구역 자체는 미들웨어가 파도소리 계정·관리자만 들인다.
const NAV = [
  { href: "/factory", label: "재고", icon: "box" as const, exact: true },
  { href: "/factory/history", label: "히스토리", icon: "receipt" as const },
  { href: "/factory/products", label: "상품마스터", icon: "fish" as const },
];
// 계정(직원 계정 만들기)은 관리자에게만 — 서버(/api/factory/accounts)가 관리자 여부를 답한다
const ADMIN_NAV = [{ href: "/factory/accounts", label: "계정", icon: "user" as const, exact: false }];

export default function FactoryShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/factory";
  const [admin, setAdmin] = useState(false);

  useEffect(() => { document.title = "파도소리 재고관리"; }, []);
  useEffect(() => {
    if (pathname === "/factory/login") return;
    fetch("/api/factory/accounts?check=1", { cache: "no-store" })
      .then((r) => setAdmin(r.ok)).catch(() => setAdmin(false));
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
          {[...NAV, ...(admin ? ADMIN_NAV : [])].map((m) => {
            const active = m.exact ? pathname === m.href : pathname.startsWith(m.href);
            return (
              <Link key={m.href} href={m.href} className={`fac-nav-item ${active ? "is-active" : ""}`}>
                <Icon name={m.icon} />
                {m.label}
              </Link>
            );
          })}
        </nav>
        {/* 사용자 이름·씨몬스터 도구로 링크는 뺐다(2026-10-20 대표 지시) — 로그아웃만. Swit 알림 설정은 2026-10-29 삭제. */}
        <div className="fac-sb-foot">
          <button type="button" onClick={logout}>로그아웃</button>
        </div>
      </aside>
      <main className="fac-main">{children}</main>
    </div>
  );
}
