import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "씨몬스터 내부 도구",
  description: "회의 정리 · 문장 교정 AI 도구",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <header className="header">
          <div className="header-inner">
            <Link href="/" className="header-logo">
              씨몬스터
            </Link>
            <nav className="header-nav">
              <Link href="/" className="header-nav-link">회의 정리</Link>
              <Link href="/correct" className="header-nav-link">문장 교정</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
