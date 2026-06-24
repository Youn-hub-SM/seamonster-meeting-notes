"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// 전역 상단 헤더(씨몬스터 + 회의정리~B2B).
// B2B 화면(/b2b/*)에서는 자체 단일 바 + 햄버거 메뉴를 쓰므로 숨김.
export default function SiteHeader() {
  const pathname = usePathname();
  const [gitbook, setGitbook] = useState("");

  // 매뉴얼(GitBook) 링크 — 설정에 등록돼 있으면 네비에 노출
  useEffect(() => {
    fetch("/api/links", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok && j.gitbook) setGitbook(j.gitbook); })
      .catch(() => {});
  }, []);

  if (pathname?.startsWith("/b2b")) return null;

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
          {gitbook && (
            <a href={gitbook} target="_blank" rel="noopener noreferrer" className="header-nav-link">
              가이드라인 ↗
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}
