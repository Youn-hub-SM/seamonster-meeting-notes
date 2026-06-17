import type { Metadata } from "next";
import "./globals.css";
import SiteHeader from "./SiteHeader";

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
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
