"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AppSidebar from "./AppSidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);

  // 로그인 페이지는 사이드바 없이 전체 화면
  if (pathname === "/b2b/login") return <>{children}</>;

  return (
    <div className="app-shell">
      <AppSidebar open={open} onNavigate={() => setOpen(false)} />
      {open && <div className="app-sb-backdrop" onClick={() => setOpen(false)} />}
      <div className="app-main">
        <div className="app-topbar">
          <button type="button" className="app-sb-toggle" onClick={() => setOpen(true)} aria-label="메뉴">☰</button>
          <Link href="/" className="app-topbar-brand">씨몬스터</Link>
        </div>
        {children}
      </div>
    </div>
  );
}
