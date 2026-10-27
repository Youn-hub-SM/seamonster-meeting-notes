import { redirect } from "next/navigation";

// 옛 'CS 코치' 화면 — 2026-10-22 AI 비서(cs_coach 도구)가 대신한다. 응대 매뉴얼은 2026-10-27 셰어포인트 매뉴얼('[비서] CS' 등)로 옮겼다.
export default function Page() {
  redirect("/report");
}
