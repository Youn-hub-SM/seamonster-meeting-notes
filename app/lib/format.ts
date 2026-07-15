// 공용 표기 헬퍼 — 금액·수량이 화면마다 다른 반올림/축약으로 나오지 않게 한 곳에 둔다.
// (won() 이 화면마다 재정의돼 일부는 반올림이 없어, 같은 금액이 화면에 따라
//  "1,234.5" 와 "1,235" 로 갈릴 수 있었다.)
// 억/만 축약은 charts.tsx 의 moneyCompact 를 그대로 쓴다(축 라벨과 같은 표기).

/** 정수 반올림 + 천단위 콤마. null/undefined 는 "-" */
export const won = (n: number | null | undefined): string =>
  n == null ? "-" : Math.round(Number(n) || 0).toLocaleString();
