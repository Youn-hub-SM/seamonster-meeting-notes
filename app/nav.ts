// 좌측 사이드바 네비 구성 — 분류(카테고리) → 툴 → 툴 메뉴(하위 페이지).
//  분류·소속은 여기 배열만 고치면 바로 반영됨.

import type { IconName } from "./components/Icon";

export type NavMenuItem = { href: string; label: string; adminOnly?: boolean };
export type NavTool = { href: string; label: string; icon: IconName; adminOnly?: boolean; menu?: NavMenuItem[] };
export type NavCategory = { label: string; adminOnly?: boolean; tools: NavTool[] };

export const HOME: NavTool = { href: "/", label: "홈", icon: "home" };

export const NAV: NavCategory[] = [
  {
    label: "세일즈",
    tools: [
      {
        href: "/b2b", label: "B2B", icon: "handshake",
        menu: [
          { href: "/b2b", label: "대시보드" },
          { href: "/b2b/orders", label: "발주" },
          { href: "/b2b/companies", label: "업체 주소록" },
          { href: "/b2b/margin", label: "이익률" },
          { href: "/b2b/reports", label: "매출 집계" },
          { href: "/b2b/payments", label: "입금 확인" },
          { href: "/b2b/history", label: "변경 기록" },
        ],
      },
      {
        href: "/b2b/products", label: "상품 마스터", icon: "fish",
        menu: [
          { href: "/b2b/products", label: "상품 목록" },
          { href: "/b2b/products/history", label: "변경 기록" },
          { href: "/inventory/bundles", label: "묶음 상품" },
        ],
      },
      {
        href: "/fulfill", label: "온라인 발주", icon: "truck",
        menu: [
          { href: "/fulfill", label: "발주처리" },
          { href: "/fulfill/scan/upload", label: "송장 업로드" },
          { href: "/fulfill/scan", label: "송장 스캔" },
          { href: "/fulfill/log", label: "배송일지" },
          { href: "/fulfill/stats", label: "발송 통계" },
          { href: "/fulfill/settings", label: "단가 설정" },
        ],
      },
      {
        href: "/sales", label: "매출", icon: "bars",
        menu: [
          { href: "/sales", label: "대시보드" },
          { href: "/sales/upload", label: "데이터 업로드" },
          { href: "/sales/report", label: "리포트" },
          { href: "/sales/profit", label: "채널별 이익" },
          { href: "/sales/search", label: "주문 검색" },
          { href: "/sales/history", label: "변경 기록" },
        ],
      },
      { href: "/coupon", label: "쿠폰 요청서", icon: "ticket" },
      { href: "/subscription", label: "정기배송 분석", icon: "trend" },
    ],
  },
  {
    label: "생산·재고",
    tools: [
      {
        href: "/production", label: "생산 관리", icon: "factory",
        menu: [
          { href: "/production", label: "생산 일정" },
          { href: "/production/board", label: "생산 보드" },
          { href: "/production/request", label: "생산 요청서" },
        ],
      },
      {
        href: "/inventory", label: "재고 관리", icon: "box",
        menu: [
          { href: "/inventory", label: "재고 목록" },
          { href: "/inventory/trade", label: "구매 및 판매" },
          { href: "/inventory/adjust", label: "재고 조정" },
          { href: "/inventory/move", label: "재고 옮기기(소매↔도매)" },
          { href: "/inventory/quote", label: "월간매입 견적서" },
          { href: "/inventory/asof", label: "과거 수량 조회" },
        ],
      },
      // 합친/독립 메뉴
      { href: "/production/inventory", label: "재고/생산 조언", icon: "bulb" },
      { href: "/inventory/stats", label: "재고/생산 통계", icon: "bars" },
      { href: "/inventory/reconcile", label: "구매·판매·재고 확인", icon: "receipt" },
      { href: "/inventory/activity", label: "변경 기록", icon: "receipt" },
      { href: "/production/sku", label: "SKU 생성기", icon: "tag" },
    ],
  },
  {
    label: "마케팅",
    tools: [
      { href: "/utm", label: "UTM 만들기", icon: "link" },
      { href: "/qr", label: "QR코드/브랜드링크", icon: "qrcode" },
      {
        href: "/naver-ad", label: "광고", icon: "trend",
        menu: [
          { href: "/naver-ad", label: "네이버 광고" },
          { href: "/meta-ad", label: "메타 광고" },
        ],
      },
      { href: "/crm", label: "CRM 메시지맵", icon: "megaphone" },
      { href: "/correct", label: "문장 교정", icon: "pen" },
    ],
  },
  {
    label: "CS",
    tools: [
      {
        href: "/cs", label: "CS 코치", icon: "chat",
        menu: [
          { href: "/cs", label: "코치" },
          { href: "/cs/manual", label: "매뉴얼" },
        ],
      },
      {
        href: "/voc", label: "VOC 관리", icon: "megaphone",
        menu: [
          { href: "/voc", label: "VOC 처리" },
          { href: "/voc/stats", label: "통계·보고서" },
          { href: "/voc/insights", label: "AI 인사이트" },
          { href: "/voc/loss", label: "손해금액 산정" },
          { href: "/voc/reports", label: "개선요청서" },
          { href: "/voc/manufacturer", label: "월간 VOC 리포트" },
          { href: "/voc/surveys", label: "설문 응답(Tally)" },
        ],
      },
    ],
  },
  {
    label: "기타",
    tools: [
      { href: "/sales/margin-calc", label: "이익률 계산기", icon: "bulb" },
      { href: "/meeting", label: "회의 정리", icon: "note" },
      { href: "https://seamonster.gitbook.io/guide", label: "씨몬스터 가이드", icon: "book" },
    ],
  },
  {
    label: "관리자",
    adminOnly: true, // 관리자·현석에게만 노출
    tools: [
      { href: "/b2b/users", label: "계정 관리", icon: "user" },
      {
        href: "/b2b/settings", label: "설정", icon: "gear",
        menu: [
          { href: "/b2b/settings/ai", label: "AI 설정" },
          { href: "/b2b/settings", label: "B2B 도매" },
          { href: "/production/settings", label: "생산관리" },
          { href: "/voc/settings", label: "VOC·탈리 연동" },
        ],
      },
    ],
  },
];
