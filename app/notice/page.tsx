import { redirect } from "next/navigation";

// 옛 '공지 작성기' 화면 — 2026-10-22 AI 비서(write_notice 도구)가 대신한다. 톤 프롬프트는 관리자 › 설정 › AI.
export default function Page() {
  redirect("/report");
}
