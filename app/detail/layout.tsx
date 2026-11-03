import "../b2b/b2b.css";
import "./detail.css";

// 상세페이지 전송 — 전역 사이드바(AppShell)가 네비 담당. 스타일 로드 + 본문 래퍼(.b2b-main)만.
export const metadata = { title: "상세페이지 전송 · 씨몬스터 업무 도우미" };

export default function DetailLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
