import "../b2b/b2b.css";
import "./form-sms.css";

// 신청자 문자 — 전역 사이드바(AppShell)가 네비 담당. 스타일 로드 + 본문 래퍼만.
export default function FormSmsLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
