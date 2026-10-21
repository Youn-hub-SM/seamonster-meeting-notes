import { redirect } from "next/navigation";

// 옛 'AI 설정' 화면 — 2026-10-21 관리자 설정을 한 화면으로 합쳤다(app/b2b/settings/page.tsx). 옛 주소·즐겨찾기는 그 칸으로 넘긴다.
export default function Page() {
  redirect("/b2b/settings?s=ai");
}
