import "../b2b/b2b.css";

// AI 비서 — 전역 사이드바(AppShell)가 네비 담당. 스타일 로드 + 본문 래퍼만.
//  2026-10-21 클로드 코드식 화면: 여백 없이 화면 높이를 꽉 채운다(대화 목록·대화·입력 상자가 각자 스크롤). .rp-app-main 은 b2b.css.
export default function ReportLayout({ children }: { children: React.ReactNode }) {
  return <div className="rp-app-main">{children}</div>;
}
