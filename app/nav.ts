// 좌측 사이드바 네비 구성 — 분류(카테고리) → 툴 → 툴 메뉴(하위 페이지).
//  분류·소속은 여기 배열만 고치면 바로 반영됨.

export type NavMenuItem = { href: string; label: string; adminOnly?: boolean };
export type NavTool = { href: string; label: string; emoji: string; menu?: NavMenuItem[] };
export type NavCategory = { label: string; tools: NavTool[] };

export const HOME: NavTool = { href: "/", label: "홈", emoji: "🏠" };

export const NAV: NavCategory[] = [
  {
    label: "세일즈",
    tools: [
      {
        href: "/b2b", label: "B2B 도매", emoji: "📦",
        menu: [
          { href: "/b2b", label: "대시보드" },
          { href: "/b2b/orders", label: "발주" },
          { href: "/b2b/companies", label: "업체 주소록" },
          { href: "/b2b/products", label: "원가표" },
          { href: "/b2b/margin", label: "이익률" },
          { href: "/b2b/reports", label: "매출 집계" },
          { href: "/b2b/payments", label: "입금 확인" },
          { href: "/b2b/history", label: "히스토리" },
          { href: "/b2b/settings", label: "설정", adminOnly: true },
        ],
      },
      { href: "/subscription", label: "정기배송 분석", emoji: "📈" },
    ],
  },
  {
    label: "생산",
    tools: [
      {
        href: "/production", label: "생산관리", emoji: "🏭",
        menu: [
          { href: "/production", label: "생산일정" },
          { href: "/production/board", label: "생산 보드" },
          { href: "/production/advice", label: "생산 조언" },
          { href: "/production/inventory", label: "재고·생산필요" },
          { href: "/production/request", label: "생산요청서" },
          { href: "/production/sku", label: "SKU 생성기" },
          { href: "/production/products", label: "품목 업로드" },
          { href: "/production/settings", label: "설정", adminOnly: true },
        ],
      },
    ],
  },
  {
    label: "마케팅",
    tools: [
      { href: "/utm", label: "UTM 빌더", emoji: "🔗" },
      { href: "/correct", label: "문장 교정", emoji: "✍️" },
    ],
  },
  {
    label: "CS",
    tools: [
      {
        href: "/cs", label: "CS 코치", emoji: "💬",
        menu: [
          { href: "/cs", label: "코치" },
          { href: "/cs/manual", label: "매뉴얼" },
        ],
      },
      {
        href: "/voc", label: "VOC 관리", emoji: "📣",
        menu: [
          { href: "/voc", label: "처리 상태" },
          { href: "/voc/stats", label: "통계·리포트" },
          { href: "/voc/insights", label: "AI 인사이트" },
          { href: "/voc/loss", label: "손해금액 산정" },
          { href: "/voc/reviews", label: "후기 수집" },
          { href: "/voc/reports", label: "보고서·개선요청서" },
          { href: "/voc/export", label: "검색결과 추출" },
          { href: "/voc/sentiment", label: "긍정·부정 분석" },
          { href: "/voc/settings", label: "설정·탈리 연동" },
        ],
      },
    ],
  },
  {
    label: "기타",
    tools: [
      { href: "/meeting", label: "회의 정리", emoji: "📝" },
    ],
  },
];
