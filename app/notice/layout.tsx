// 공지 작성기 — 전역 좌측 사이드바(AppShell)가 네비 담당. 본문 여백·폭은 다른 화면과 같이 .b2b-main 이 담당(coupon/guide 와 같은 래퍼).
//  이 래퍼가 없으면 본문이 사이드바에 붙는다(2026-10-13 대표 지적).
export default function NoticeLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
