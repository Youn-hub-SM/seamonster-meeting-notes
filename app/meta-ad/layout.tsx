import "../b2b/b2b.css";

// 메타 광고 — 전역 사이드바(AppShell)가 네비 담당. 스타일 로드 + 본문 래퍼만.
export default function MetaAdLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
