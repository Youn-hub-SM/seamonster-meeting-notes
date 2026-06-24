"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 전역 상단 헤더(씨몬스터 + 회의정리~생산관리).
// B2B·생산관리 화면에서는 자체 단일 바 + 햄버거 메뉴를 쓰므로 숨김.
export default function SiteHeader() {
  const pathname = usePathname();

  if (pathname?.startsWith("/b2b") || pathname?.startsWith("/production")) return null;

  return (
    <header className="header">
      <div className="header-inner">
        <Link href="/" className="header-logo">씨몬스터</Link>
        <nav className="header-nav">
          <Link href="/" className="header-nav-link">홈</Link>
          <Link href="/meeting" className="header-nav-link">회의 정리</Link>
          <Link href="/correct" className="header-nav-link">문장 교정</Link>
          <Link href="/cs" className="header-nav-link">CS 코치</Link>
          <Link href="/utm" className="header-nav-link">UTM 빌더</Link>
          <Link href="/subscription" className="header-nav-link">정기배송 분석</Link>
          <Link href="/b2b" className="header-nav-link">B2B</Link>
          <Link href="/production" className="header-nav-link">생산관리</Link>
        </nav>
      </div>
    </header>
  );
}
