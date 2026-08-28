// 공용 표기 헬퍼 — 금액·수량이 화면마다 다른 반올림/축약으로 나오지 않게 한 곳에 둔다.
// (won() 이 화면마다 재정의돼 일부는 반올림이 없어, 같은 금액이 화면에 따라
//  "1,234.5" 와 "1,235" 로 갈릴 수 있었다.)
// 억/만 축약은 charts.tsx 의 moneyCompact 를 그대로 쓴다(축 라벨과 같은 표기).

/** 정수 반올림 + 천단위 콤마. null/undefined 는 "-" */
export const won = (n: number | null | undefined): string =>
  n == null ? "-" : Math.round(Number(n) || 0).toLocaleString();

/** 표 날짜 축약 "MM-DD" — 표 셀 표기가 화면마다 갈리지 않게 한 곳에(2026-08-28). YYYY-MM-DD 입력 전제.
 *  예외: 여러 해가 섞이는 이력 화면(주문검색 등)은 연도 포함 원문 표기 유지. */
export const dateShort = (d: string | null | undefined): string => (d ? String(d).slice(5) : "-");
