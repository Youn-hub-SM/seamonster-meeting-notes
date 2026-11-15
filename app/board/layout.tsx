import type { Metadata } from "next";
import "../b2b/b2b.css";
import "./board.css";

// 주요 지표 — 업무도우미 메뉴(사이드바) 없이 숫자만 있는 독립 화면(AppShell 이 /board 에서 셸을 뺀다).
//  모니터에 띄워 두거나 탭 하나로 열어 두는 용도. 로그인은 업무도우미 계정 그대로.
export const metadata: Metadata = { title: "주요 지표", description: "씨몬스터 주요 지표" };

export default function BoardLayout({ children }: { children: React.ReactNode }) {
  return <div className="b2b-main">{children}</div>;
}
