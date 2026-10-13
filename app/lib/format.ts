// 공용 표기 헬퍼 — 금액·수량이 화면마다 다른 반올림/축약으로 나오지 않게 한 곳에 둔다.
// (won() 이 화면마다 재정의돼 일부는 반올림이 없어, 같은 금액이 화면에 따라
//  "1,234.5" 와 "1,235" 로 갈릴 수 있었다.)
// 억/만 축약 moneyCompact 도 여기 한 곳(charts.tsx 가 그대로 다시 내보내 축 라벨과 같은 표기).

/** 정수 반올림 + 천단위 콤마. null/undefined 는 "-" */
export const won = (n: number | null | undefined): string =>
  n == null ? "-" : Math.round(Number(n) || 0).toLocaleString();

/** 금액 축약(억/만) — 차트 축 라벨·팀즈 카드 제목 헤드라인 공용. 2026-10-13 charts.tsx("use client")에서 옮김:
 *  서버(팀즈 발송)에서도 불러야 하는데 "use client" 모듈의 함수는 서버 번들에서 호출할 수 없다. charts.tsx 는 이걸 다시 내보내므로 화면 import 는 그대로. */
export function moneyCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(a % 1e8 === 0 ? 0 : 1)}억`;
  if (a >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}만`;
  return n.toLocaleString();
}

/** 표 날짜 축약 "MM-DD" — 표 셀 표기가 화면마다 갈리지 않게 한 곳에(2026-08-28). YYYY-MM-DD 입력 전제.
 *  예외: 여러 해가 섞이는 이력 화면(주문검색 등)은 연도 포함 원문 표기 유지. */
export const dateShort = (d: string | null | undefined): string => (d ? String(d).slice(5) : "-");
