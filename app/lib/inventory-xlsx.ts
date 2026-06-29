// 구매·판매(입출고) 엑셀 일괄 입력 공용 스키마.
//  실제 사용 양식 = BoxHero Order Items: 'SKU | 수량 | 단가' 3컬럼. 입고/출고 구분은 업로드 시 선택.
//  (선택 컬럼: 품목명·유형·날짜·거래처·메모 가 있으면 함께 인식.)

export const TXN_XLSX_HEADERS = ["SKU", "수량", "단가"] as const;

// 양식 예시 행
export const TXN_XLSX_EXAMPLE: (string | number)[][] = [
  ["GA-100-K-100", 100, 1500],
  ["GA-1K-K-1000", 20, 13800],
];

export function xlsxNum(v: unknown): number {
  const s = String(v ?? "").replace(/[,\s₩]/g, "");
  return s === "" ? 0 : Number(s) || 0;
}
