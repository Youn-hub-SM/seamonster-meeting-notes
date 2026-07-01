// 묶음(세트) 상품 엑셀 일괄 등록 스키마.
//  한 세트가 여러 구성품이면 '묶음SKU'를 같게 여러 줄. 원가/가격 불필요 — 묶기만.
//  예) SET-DG-100 = DG-100-O-100 × 2 + AG-100-K-100 × 3  →  두 줄.

export const BUNDLE_XLSX_HEADERS = ["묶음SKU", "묶음명", "구성품SKU", "수량"] as const;

export const BUNDLE_XLSX_EXAMPLE: (string | number)[][] = [
  ["SET-DG-100", "대구 실속세트", "DG-100-O-100", 2],
  ["SET-DG-100", "대구 실속세트", "AG-100-K-100", 3],
  ["SET-NA-200", "농어 2종세트", "NA-100-K-100", 1],
];
