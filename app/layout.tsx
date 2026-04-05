import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "씨몬스터 회의정리록",
  description: "회의 내용을 AI가 자동으로 정리해주는 내부 도구",
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
              씨몬스터 <span>회의정리록</span>
            </Link>
            <Link href="/settings" className="btn-secondary" style={{ padding: "6px 16px", fontSize: "13px" }}>
              설정
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
