// 좌측 사이드바 네비 구성 — 분류(카테고리) → 툴 → 툴 메뉴(하위 페이지).
//  분류·소속은 여기 배열만 고치면 바로 반영됨.

import type { IconName } from "./components/Icon";

// beta: 사이드바·홈 사이트맵에 회색 'BETA' 글자 배지(2026-10-14 C6 — '베타 테스트 중' 분류 해체, 상태는 배지로).
export type NavMenuItem = { href: string; label: string; adminOnly?: boolean; exact?: boolean; beta?: true }; // exact: 정확히 일치할 때만 활성(다른 독립 툴이 이 경로 아래에 있을 때)
// short: 접힌 레일(아이콘 아래 3~4자) 라벨 — 없으면 label 의 공백 뺀 앞 4자(railLabelOf).
// icon: 같은 분류 안에서 겹치지 않게(2026-10-14 C2) — Icon.tsx 에 있는 키만.
export type NavTool = { href: string; label: string; short?: string; icon: IconName; adminOnly?: boolean; exact?: boolean; beta?: true; menu?: NavMenuItem[] }; // exact: 하위 메뉴 없는 툴이 자기 주소일 때만 활성(아래 주소의 다른 화면에서 켜지지 않게)
export type NavCategory = { label: string; adminOnly?: boolean; tools: NavTool[] };
export const railLabelOf = (t: Pick<NavTool, "label" | "short">): string => t.short ?? t.label.replace(/\s+/g, "").slice(0, 4);


export const NAV: NavCategory[] = [
  {
    // 라벨 없는 최상단 그룹 — 사용 가이드·업데이트 노트(대표 지시 2026-08-24). 사이드바는 빈 라벨을 그리지 않는다.
    label: "",
    tools: [
      { href: "/guide", label: "사용 가이드", short: "가이드", icon: "book" },
      { href: "/updates", label: "업데이트 노트", short: "업데이트", icon: "note" },
      { href: "https://seamonster.gitbook.io/guide", label: "씨몬스터 가이드(GitBook)", short: "GitBook", icon: "link" },
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
          { href: "/b2b/reports", label: "매출 집계" },
          { href: "/b2b/payments", label: "입금 확인" },
          { href: "/b2b/history", label: "B2B 변경 기록" },
        ],
      },
      {
        href: "/b2b/products", label: "상품 마스터", short: "상품", icon: "fish",
        menu: [
          { href: "/b2b/products", label: "상품 목록" },
          { href: "/b2b/products/history", label: "상품 변경 기록" },
          { href: "/inventory/bundles", label: "묶음 상품" },
          { href: "/production/sku", label: "SKU 생성" },
          { href: "/sales/listings", label: "채널 재고 조정" }, // 네이버·쿠팡·공식몰에 등록된 판매 재고를 SKU 로 찾아 바꾸는 화면(구 'SKU로 재고 조정')
        ],
      },
      {
        href: "/fulfill", label: "온라인 발주", short: "온라인", icon: "truck",
        menu: [
          { href: "/fulfill", label: "발주처리" },
          { href: "/fulfill/scan/upload", label: "송장 업로드" },
          { href: "/fulfill/scan", label: "송장 스캔" },
          { href: "/fulfill/locations", label: "창고 위치" },
          { href: "/fulfill/log", label: "배송일지" },
          { href: "/fulfill/stats", label: "발송 통계" },
        ],
      },
      {
        href: "/sales/upload", label: "매출", icon: "bars", // 대시보드·주문 검색 제거(2026-09-17) — 매출 홈=업로드
        menu: [
          { href: "/sales/upload", label: "데이터 업로드" },
          { href: "/sales/report", label: "리포트" },
          { href: "/sales/profit", label: "채널별 이익" },
          { href: "/sales/history", label: "매출 변경 기록" },
        ],
      },
      { href: "/coupon", label: "쿠폰 요청서", short: "쿠폰", icon: "ticket" },
      { href: "/subscription", label: "정기배송 분석", short: "정기배송", icon: "trend" },
    ],
  },
  {
    label: "생산·재고",
    tools: [
      // 2026-07-28 재편: 구매 및 판매를 상단으로, 생산/재고를 각각 묶고 나머지는 독립 메뉴.
      //  2026-08-28 정리: 생산 보드·제조사 요청서·재고 부족 알림 페이지 삭제(재도입 시 새로 구현).
      { href: "/inventory/trade", label: "입고 및 출고", short: "입출고", icon: "box" },
      {
        // 2026-09-28: 생산 관리 + 재고 관리를 '생산 및 재고' 하나로(대표 지시). 생산 일정은 미사용이라 아래 BETA 배지 항목으로.
        href: "/production/request", label: "생산 및 재고", short: "생산재고", icon: "factory",
        menu: [
          { href: "/production/request", label: "생산 요청" },
          { href: "/inventory/quote", label: "월간매입 결산" },
          { href: "/inventory", label: "재고 목록", exact: true }, // /inventory/* 에 다른 하위 메뉴가 있어 정확히 일치할 때만
          { href: "/inventory/adjust", label: "재고 조정" },
          { href: "/inventory/move", label: "재고 이동" },
          { href: "/inventory/asof", label: "날짜별 재고" },
        ],
      },
      { href: "/inventory/reconcile", label: "재고 대사", short: "재고대사", icon: "receipt" }, // 구매·판매·재고 확인(대사)
      { href: "/inventory/ledger-check", label: "원장 점검", short: "원장점검", icon: "book" }, // 2026-10-11 대표 결정 D4d — 주 1회 장부 이상 확인(읽기 전용)
      { href: "/inventory/activity", label: "재고 변경 기록", short: "재고기록", icon: "note" },
      { href: "/production", label: "생산 일정", short: "생산일정", icon: "bars", exact: true, beta: true }, // 2026-09-28 생산 및 재고에서 뺌 — 현재 미사용, 재검토 전까지 BETA. exact: /production/request 등에서 켜지지 않게

      // 파도소리(제조사) 자체 원장 — 로트 단위. 씨몬스터 재고와 연결되지 않는 별도 데이터다.
      // 접근은 파도소리 계정+관리자만(미들웨어 차단) — 일반 직원에겐 메뉴도 숨긴다.
      { href: "/factory", label: "파도소리 재고", short: "파도소리", icon: "fish", adminOnly: true, beta: true },
    ],
  },
  {
    label: "마케팅",
    tools: [
      { href: "/utm", label: "UTM 만들기", short: "UTM", icon: "link" },
      { href: "/qr", label: "QR코드/브랜드링크", short: "QR", icon: "qrcode" },
      {
        href: "/naver-ad", label: "광고", icon: "trend",
        menu: [
          { href: "/naver-ad", label: "네이버 광고" },
          { href: "/meta-ad", label: "메타 광고" },
          { href: "/meta-ad/library", label: "메타 소재 라이브러리" },
        ],
      },
      { href: "/crm", label: "CRM 메시지맵", short: "CRM", icon: "megaphone" },
      { href: "/instagram", label: "인스타 자동 DM", short: "인스타", icon: "chat" },
    ],
  },
  {
    label: "CS",
    tools: [
      {
        href: "/cs", label: "CS 코치", short: "CS", icon: "chat",
        menu: [
          { href: "/cs", label: "코치" },
          { href: "/cs/manual", label: "매뉴얼" },
        ],
      },
      { href: "/notice", label: "공지 작성기", short: "공지", icon: "pen" }, // 2026-10-13 상황 항목 → 씨몬스터 톤 공지문(고객·B2B)
      {
        href: "/voc", label: "VOC 관리", short: "VOC", icon: "megaphone",
        menu: [
          { href: "/voc", label: "VOC 처리" },
          { href: "/voc/stats", label: "통계" },
          { href: "/voc/reports", label: "개선요청서" },
          { href: "/voc/manufacturer", label: "월간 VOC 리포트" },
        ],
      },
      // 2026-10-14 C6: '베타 테스트 중' 분류 해체 — VOC 베타 두 개는 CS 로, BETA 배지로 상태 표시
      { href: "/voc/insights", label: "VOC AI 인사이트", short: "인사이트", icon: "bulb", beta: true },
      { href: "/voc/surveys", label: "VOC 설문응답(Tally)", short: "설문", icon: "note", beta: true },
    ],
  },
  {
    label: "기타",
    tools: [
      { href: "/briefing", label: "종합 리포트", short: "종합", icon: "bulb" }, // 2026-09-30 모두 열람, 일일·주간·월간 탭(매출 업로드 뒤 담당자가 생성·발송)
      { href: "/report", label: "커스텀 리포트", short: "커스텀", icon: "bars" },
      { href: "/sales/margin-calc", label: "이익률 계산기", short: "이익률", icon: "tag" },
      { href: "/meeting", label: "회의 정리", short: "회의", icon: "note" },
    ],
  },
  {
    label: "관리자",
    adminOnly: true, // 관리자·현석에게만 노출
    tools: [
      { href: "/b2b/users", label: "계정 관리", short: "계정", icon: "user" },
      {
        href: "/b2b/settings", label: "설정", icon: "gear",
        menu: [
          { href: "/b2b/settings/ai", label: "AI 설정" },
          { href: "/b2b/settings/teams", label: "Teams 연동" },
          { href: "/b2b/settings/asana", label: "아사나 연동" },
          { href: "/b2b/settings/tally", label: "Tally 연동" },
          { href: "/fulfill/settings", label: "온라인 발주 설정" },
          { href: "/b2b/settings", label: "일반 설정", exact: true },
        ],
      },
      // dev 브랜치 고정 미리보기 주소 — push 때마다 최신 베타로 갱신된다(주소 불변). 2026-10-14 C6: 베타 분류 해체로 관리자 분류로 이동
      { href: "https://meeting-notes-git-dev-younhyunshuk-5999s-projects.vercel.app", label: "베타 버전", short: "베타", icon: "link" },
    ],
  },
];

// ── 즐겨찾기 표시 — 담을 때 저장한 이름 대신 지금 메뉴 이름으로(메뉴 개편 뒤 옛 이름이 남지 않게), 활성 판정도 메뉴와 같은 규칙 ──
//  하위 메뉴 없는 툴 = 툴 이름, 하위 메뉴 = '툴 · 메뉴'. 같은 href 는 먼저 나온 자리.
const NAV_META: Map<string, { label: string; exact: boolean }> = (() => {
  const m = new Map<string, { label: string; exact: boolean }>();
  for (const cat of NAV) for (const t of cat.tools) {
    if (!t.menu?.length) { if (!m.has(t.href)) m.set(t.href, { label: t.label, exact: !!t.exact }); continue; }
    for (const sub of t.menu) if (!m.has(sub.href)) m.set(sub.href, { label: `${t.label} · ${sub.label}`, exact: !!sub.exact || sub.href === t.href });
  }
  return m;
})();
export const navLabelOf = (href: string, fallback: string): string => NAV_META.get(href)?.label ?? fallback;

// ── 브라우저 탭 제목(2026-10-08 대표 지시 — 탭을 여러 개 띄우면 전부 같은 이름이라 헷갈림) ──
//  '메뉴 · 툴 | 업무도우미' 순 — 좁은 탭엔 앞부분만 보이므로 구분되는 이름을 앞에 둔다. 메뉴 이름은 NAV 그대로.
//  NAV 에 없는 화면(상세·작성·로그인·파도소리)은 아래 표. 주소는 정확히 일치 → 가장 긴 상위 주소 순으로 찾는다.
const TITLE_SUFFIX = " | 업무도우미";
const TITLE_EXTRA: { re: RegExp; title: string }[] = [
  { re: /^\/b2b\/orders\/new$/, title: "새 발주 · B2B" },
  { re: /^\/b2b\/orders\/(statement|[^/]+\/statement)$/, title: "거래명세표 · B2B" },
  { re: /^\/b2b\/orders\/[^/]+$/, title: "발주 상세 · B2B" },
  { re: /^\/b2b\/companies\/[^/]+$/, title: "업체 상세 · B2B" },
  { re: /^\/inventory\/trade\/new$/, title: "입고/출고 기록" },
  { re: /^\/meta-ad\/settings$/, title: "판정 기준 설정 · 메타 광고" },
  { re: /^\/b2b\/login$/, title: "로그인" },
  { re: /^\/factory\/login$/, title: "로그인 · 파도소리" },
  { re: /^\/factory$/, title: "재고 · 파도소리" },
  { re: /^\/factory\/history$/, title: "히스토리 · 파도소리" },
  { re: /^\/factory\/products$/, title: "상품마스터 · 파도소리" },
  { re: /^\/factory\/settings$/, title: "알림 설정 · 파도소리" },
];
const TITLE_META: { href: string; title: string; exact: boolean }[] = (() => {
  const out: { href: string; title: string; exact: boolean }[] = [];
  const seen = new Set<string>();
  const add = (href: string, title: string, exact: boolean) => { if (!href.startsWith("/") || seen.has(href)) return; seen.add(href); out.push({ href, title, exact }); };
  for (const cat of NAV) for (const t of cat.tools) {
    for (const sub of t.menu || []) add(sub.href, sub.label === t.label ? t.label : `${sub.label} · ${t.label}`, !!sub.exact);
    add(t.href, t.label, !!t.exact);
  }
  return out;
})();
export function pageTitleOf(pathname: string): string {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  if (p === "/") return "업무도우미";
  const extra = TITLE_EXTRA.find((x) => x.re.test(p));
  if (extra) return extra.title.includes("파도소리") ? extra.title : extra.title + TITLE_SUFFIX; // 파도소리는 별도 사이트
  const exact = TITLE_META.find((m) => m.href === p);
  if (exact) return exact.title + TITLE_SUFFIX;
  const parent = TITLE_META.filter((m) => !m.exact && p.startsWith(m.href + "/")).sort((a, b) => b.href.length - a.href.length)[0];
  return parent ? parent.title + TITLE_SUFFIX : "씨몬스터 업무 도우미";
}
export function navHrefActive(href: string, pathname: string): boolean {
  if (NAV_META.get(href)?.exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

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
