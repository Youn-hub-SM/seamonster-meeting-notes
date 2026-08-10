import { redirect } from "next/navigation";

// B2B 대시보드는 없앴다 — 거기서 보던 '오늘 할일'(오늘 발송·발송일정 미등록·계산서 미발행·
//  입금 대기)은 발주 관리 화면 위쪽 카드로 옮겼다. 요약만 보고 다시 발주로 넘어가는 단계가
//  사라진 셈이라 /b2b 로 들어오면 곧장 발주 목록으로 보낸다(옛 북마크·링크 보존).
export default function B2BIndex() {
  redirect("/b2b/orders");
}
