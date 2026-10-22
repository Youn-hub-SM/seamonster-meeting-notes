import { redirect } from "next/navigation";

// 옛 'CS 코치' 화면 — 2026-10-22 AI 비서(cs_coach 도구)가 대신한다. 매뉴얼은 /cs/manual 그대로.
export default function Page() {
  redirect("/report");
}
