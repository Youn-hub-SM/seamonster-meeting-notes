import "../b2b/b2b.css";

// VOC 관리툴 — 전역 좌측 사이드바(AppShell)가 네비를 담당. 스타일 로드 + 본문 래퍼만.
export default function VocLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
