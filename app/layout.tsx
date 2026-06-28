import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./AppShell";

export const metadata: Metadata = {
  title: "씨몬스터 내부 도구",
  description: "씨몬스터 사내 도구 모음 — 세일즈·생산·마케팅",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
