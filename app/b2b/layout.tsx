"use client";

import { usePathname } from "next/navigation";
import "./b2b.css";

// 전역 좌측 사이드바(AppShell)가 네비·인증 표시를 담당.
//  여기서는 B2B 페이지 스타일(b2b.css)만 로드하고 본문 폭/여백 래퍼만 제공.
//  로그인 페이지는 사이드바 없이 전체 화면(AppShell 에서도 제외).
export default function B2BLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/b2b/login") return <>{children}</>;
  return <div className="b2b-main">{children}</div>;
}
