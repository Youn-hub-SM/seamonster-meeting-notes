import { redirect } from "next/navigation";

// '정기배송 분석' 메뉴와 화면은 2026-11-18 없앴다(대표: "주요 지표에서도 볼 수 있기 때문").
//  옛 주소·즐겨찾기·업데이트 노트의 링크는 주요 지표의 [정기배송 분석] 탭으로 보낸다.
//  계산과 그림은 public/subscription-dashboard.html 그대로다 — 주요 지표가 그 파일을 ?board=1 로 넣어 쓴다(지우지 말 것).
export default function SubscriptionMovedPage() {
  redirect("/board?tab=subx");
}
