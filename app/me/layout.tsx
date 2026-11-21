import type { Metadata } from "next";
import "./me.css";

// 직원 확인 링크(/me/<토큰>)의 문서 머리 — 루트(app/layout.tsx)의 이름·설명을 덮어쓴다.
//  직원이 로그인 없이 여는 화면이라 업무도우미·급여 창의 이름·메뉴·로고를 두지 않는다. 검색 엔진에도 싣지 않는다.
export const metadata: Metadata = {
  title: "급여·연차 확인",
  description: "급여·연차 확인",
  robots: { index: false, follow: false },
};

export default function MeLayout({ children }: { children: React.ReactNode }) {
  return <div className="me-root">{children}</div>;
}
