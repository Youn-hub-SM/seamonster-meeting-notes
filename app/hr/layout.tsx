import type { Metadata } from "next";
import HrShell from "./HrShell";

// 급여·연차 창의 문서 머리 — 루트(app/layout.tsx)의 이름·설명을 덮어쓴다.
//  이 창은 업무도우미 메뉴·검색·가이드 어디에도 올리지 않는다(docs/payroll-leave-plan.md 2장). 검색 엔진에도 싣지 않는다.
export const metadata: Metadata = {
  title: "급여·연차",
  description: "급여·연차",
  robots: { index: false, follow: false },
};

export default function HrLayout({ children }: { children: React.ReactNode }) {
  return <HrShell>{children}</HrShell>;
}
