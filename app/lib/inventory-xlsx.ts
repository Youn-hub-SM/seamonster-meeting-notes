// 구매·판매(입출고) 엑셀 일괄 입력 공용 스키마 — 템플릿과 임포트가 같은 헤더를 공유.
//  한 줄 = 한 입출고. 품목은 SKU(우선) 또는 품목명으로 매칭.

export const TXN_XLSX_HEADERS = ["유형", "날짜", "SKU", "품목명", "수량", "단가", "거래처", "메모"] as const;

// 양식 예시 행(다운로드 템플릿에 안내용으로 포함)
export const TXN_XLSX_EXAMPLE: (string | number)[][] = [
  ["입고", "2026-06-29", "GA-100-K-100", "광어순살(100g)", 100, 1500, "○○수산", "정기 매입"],
  ["출고", "2026-06-29", "", "광어순살(1kg)", 5, 22000, "쿠팡", "판매"],
];

export function xlsxNum(v: unknown): number {
  const s = String(v ?? "").replace(/[,\s₩]/g, "");
  return s === "" ? 0 : Number(s) || 0;
}
