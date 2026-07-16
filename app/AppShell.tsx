"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AppSidebar from "./AppSidebar";
import { recordVisit } from "./lib/recent-pages";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);          // 모바일 드로어 열림
  const [collapsed, setCollapsed] = useState(false); // 데스크톱 접기(아이콘만)
  const [desktop, setDesktop] = useState(true);      // 접기는 데스크톱에서만 적용

  // 접힘 상태 복원 + 데스크톱 여부 추적(모바일에선 접기 무시 → 드로어 그대로)
  useEffect(() => {
    try { setCollapsed(localStorage.getItem("sb_collapsed") === "1"); } catch {}
    const mq = window.matchMedia("(min-width: 901px)");
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 최근 방문 기록(홈 퀵런치용) — 경로가 바뀔 때 네비 항목 단위로 저장
  useEffect(() => { recordVisit(pathname); }, [pathname]);

  function toggleCollapse() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("sb_collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }

  // 로그인 페이지는 사이드바 없이 전체 화면
  if (pathname === "/b2b/login") return <>{children}</>;

  const isCollapsed = collapsed && desktop;

  return (
    <div className={`app-shell ${isCollapsed ? "is-collapsed" : ""}`}>
      <AppSidebar open={open} collapsed={isCollapsed} onToggleCollapse={toggleCollapse} onNavigate={() => setOpen(false)} />
      {open && <div className="app-sb-backdrop" onClick={() => setOpen(false)} />}
      <div className="app-main">
        <div className="app-topbar">
          <button type="button" className="app-sb-toggle" onClick={() => setOpen(true)} aria-label="메뉴" aria-expanded={open}>☰</button>
          <Link href="/" className="app-topbar-brand">씨몬스터</Link>
        </div>
        {children}
      </div>
    </div>
  );
}
