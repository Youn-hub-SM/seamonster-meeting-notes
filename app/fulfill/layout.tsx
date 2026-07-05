import "../b2b/b2b.css";

// 택배 발주처리 — 전역 사이드바(AppShell)가 네비. 스타일 로드 + 본문 래퍼.
export default function FulfillLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
