import type { Metadata } from "next";
import FactoryShell from "./FactoryShell";

// 파도소리 구역의 문서 머리(탭 제목·설명·아이콘) — 루트(app/layout.tsx)의 씨몬스터 이름·아이콘을 덮어쓴다.
//  대표 규칙(2026-10-20): 파도소리 화면만 봐서는 씨몬스터 업무도우미를 전혀 알 수 없어야 한다.
//  아이콘은 이 폴더의 icon.png·apple-icon.png(파일 규칙)가 쓰인다.
export const metadata: Metadata = {
  title: "파도소리 재고관리",
  description: "파도소리 재고관리",
};

export default function FactoryLayout({ children }: { children: React.ReactNode }) {
  return <FactoryShell>{children}</FactoryShell>;
}
