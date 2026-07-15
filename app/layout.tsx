import type { Metadata } from "next";
import "./globals.css";
import "./b2b/b2b.css"; // 공용 컴포넌트 라이브러리(.b2b-*) — 전 화면에서 쓰므로 루트에서 로드(한 어플, 한 스타일)
import AppShell from "./AppShell";

export const metadata: Metadata = {
  title: "씨몬스터 업무 도우미",
  description: "씨몬스터 업무 도우미 — 세일즈·생산·마케팅",
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
