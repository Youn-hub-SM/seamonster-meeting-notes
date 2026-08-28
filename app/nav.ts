// 좌측 사이드바 네비 구성 — 분류(카테고리) → 툴 → 툴 메뉴(하위 페이지).
//  분류·소속은 여기 배열만 고치면 바로 반영됨.

import type { IconName } from "./components/Icon";

export type NavMenuItem = { href: string; label: string; adminOnly?: boolean; exact?: boolean }; // exact: 정확히 일치할 때만 활성(다른 독립 툴이 이 경로 아래에 있을 때)
export type NavTool = { href: string; label: string; icon: IconName; adminOnly?: boolean; menu?: NavMenuItem[] };
export type NavCategory = { label: string; adminOnly?: boolean; tools: NavTool[] };


export const NAV: NavCategory[] = [
  {
    // 라벨 없는 최상단 그룹 — 사용 가이드·업데이트 노트(대표 지시 2026-08-24). 사이드바는 빈 라벨을 그리지 않는다.
    label: "",
    tools: [
      { href: "/guide", label: "사용 가이드", icon: "book" },
      { href: "/updates", label: "업데이트 노트", icon: "note" },
      { href: "https://seamonster.gitbook.io/guide", label: "씨몬스터 가이드(GitBook)", icon: "book" },
    ],
  },
  {
    label: "세일즈",
    tools: [
      {
        href: "/b2b/orders", label: "B2B", icon: "handshake",
        menu: [
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
          { href: "/production/sku", label: "SKU 생성" },
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
        ],
      },
      {
        href: "/sales", label: "매출", icon: "bars",
        menu: [
          { href: "/sales", label: "대시보드" },
          { href: "/sales/weekly", label: "주간 브리핑" },
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
      // 2026-07-28 재편: 구매 및 판매를 상단으로, 생산/재고를 각각 묶고 나머지는 독립 메뉴.
      //  2026-08-28 정리: 생산 보드·제조사 요청서·재고 부족 알림 페이지 삭제(재도입 시 새로 구현).
      { href: "/inventory/trade", label: "입고 및 출고", icon: "receipt" },
      {
        href: "/production", label: "생산 관리", icon: "factory",
        menu: [
          { href: "/production", label: "생산 일정" },
          { href: "/production/request", label: "생산 요청" },
          // 2026-07-29: '생산' 화면은 재고 목록으로 통합(권장생산·주문필요·보정·생산 요청 생성).
          { href: "/inventory/quote", label: "월간매입 결산" },
        ],
      },
      {
        href: "/inventory", label: "재고 관리", icon: "box",
        menu: [
          { href: "/inventory", label: "재고 목록" },
          { href: "/inventory/adjust", label: "재고 조정" },
          { href: "/inventory/move", label: "소매↔도매" },
          { href: "/inventory/asof", label: "과거수량 조회" },
        ],
      },
      { href: "/inventory/stats", label: "통계", icon: "bars" },
      { href: "/inventory/reconcile", label: "구매/판매/재고 확인", icon: "receipt" },
      { href: "/inventory/activity", label: "변경기록", icon: "receipt" },
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
          { href: "/meta-ad/library", label: "메타 소재 라이브러리" },
        ],
      },
      { href: "/crm", label: "CRM 메시지맵", icon: "megaphone" },
      { href: "/instagram", label: "인스타 자동 DM", icon: "chat" },
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
          { href: "/voc/monthly", label: "월말 결산" },
          { href: "/voc/stats", label: "통계·보고서" },
          { href: "/voc/loss", label: "손해금액 산정" },
          { href: "/voc/reports", label: "개선요청서" },
          { href: "/voc/manufacturer", label: "월간 VOC 리포트" },
        ],
      },
    ],
  },
  {
    label: "기타",
    tools: [
      { href: "/report", label: "커스텀 리포트", icon: "bars" },
      { href: "/sales/margin-calc", label: "이익률 계산기", icon: "bulb" },
      { href: "/meeting", label: "회의 정리", icon: "note" },
    ],
  },
  {
    label: "베타 테스트 중",
    tools: [
      // dev 브랜치 고정 미리보기 주소 — push 때마다 최신 베타로 갱신된다(주소 불변)
      { href: "https://meeting-notes-git-dev-younhyunshuk-5999s-projects.vercel.app", label: "베타 버전", icon: "link" },
      { href: "/htmlshot", label: "상세 이미지 변환", icon: "image" },
      { href: "/correct", label: "문장 교정", icon: "pen" },
      { href: "/pallet", label: "파렛트 적재", icon: "box" },
      { href: "/voc/insights", label: "VOC AI 인사이트", icon: "bulb" },
      { href: "/voc/surveys", label: "VOC 설문응답(Tally)", icon: "chat" },
      // 파도소리(제조사) 자체 원장 — 로트 단위. 씨몬스터 재고와 연결되지 않는 별도 데이터다.
      // 접근은 파도소리 계정+관리자만(미들웨어 차단) — 일반 직원에겐 메뉴도 숨긴다.
      { href: "/factory", label: "파도소리 재고", icon: "factory", adminOnly: true },
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
          { href: "/b2b/settings/teams", label: "Teams 연동" },
          { href: "/b2b/settings/asana", label: "아사나 연동" },
          { href: "/b2b/settings/tally", label: "Tally 연동" },
          { href: "/fulfill/settings", label: "온라인 발주" },
          { href: "/b2b/settings", label: "기타", exact: true },
        ],
      },
    ],
  },
];

// ── 즐겨찾기 정렬 — 담은 순서가 아니라 실제 메뉴 순서(분류 → 툴 → 하위 메뉴)로 ──
//  NAV 를 위에서부터 순회한 등장 순서를 href 별 인덱스로 만든다. 같은 href 가 툴과
//  하위 메뉴에 모두 나오면(예: /inventory) 먼저 나온 자리를 쓴다. NAV 에 없는 href
//  (삭제된 메뉴의 옛 즐겨찾기)는 맨 뒤로 보내되 담은 순서를 유지한다.
const NAV_ORDER: Map<string, number> = (() => {
  const m = new Map<string, number>();
  let i = 0;
  for (const cat of NAV) for (const t of cat.tools) {
    if (!m.has(t.href)) m.set(t.href, i++);
    for (const sub of t.menu || []) if (!m.has(sub.href)) m.set(sub.href, i++);
  }
  return m;
})();

export function sortByNavOrder<T extends { href: string }>(list: T[]): T[] {
  return list
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const ai = NAV_ORDER.get(a.item.href) ?? Number.POSITIVE_INFINITY;
      const bi = NAV_ORDER.get(b.item.href) ?? Number.POSITIVE_INFINITY;
      return ai !== bi ? ai - bi : a.idx - b.idx; // 미등록 href 끼리는 담은 순서 유지
    })
    .map((x) => x.item);
}
