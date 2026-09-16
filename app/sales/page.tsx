import { redirect } from "next/navigation";

// 매출 대시보드 제거(2026-09-17 대표 지시 — 미사용 정리). 옛 링크·즐겨찾기는 업로드 화면으로.
export default function SalesIndex() {
  redirect("/sales/upload");
}
