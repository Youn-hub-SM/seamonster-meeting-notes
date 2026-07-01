// 구매·판매(입출고) 엑셀 일괄 입력 공용 스키마.
//  실제 사용 양식 = BoxHero Order Items: 'SKU | 수량 | 단가' 3컬럼. 입고/출고 구분은 업로드 시 선택.
//  (선택 컬럼: 품목명·유형·날짜·거래처·메모 가 있으면 함께 인식.)

export const TXN_XLSX_HEADERS = ["SKU", "수량", "단가"] as const;

// 양식 예시 행
export const TXN_XLSX_EXAMPLE: (string | number)[][] = [
  ["GA-100-K-100", 100, 1500],
  ["GA-1K-K-1000", 20, 13800],
];

// ── 출고(판매) 전용 양식: 1열=수량 · 2열=(무시) · 3열=SKU ──
//  외부 출고/판매 내보내기 파일을 그대로 올릴 수 있게 위치(열 순서) 기준으로 읽는다.
//  가운데 열은 무시(빈칸). 단가 없음 — 판매속도(출고추세) 워밍업용. 거래일은 업로드 시 지정.
export const OUT_TXN_XLSX_HEADERS = ["수량", "(무시)", "SKU"] as const;
export const OUT_TXN_XLSX_EXAMPLE: (string | number)[][] = [
  [100, "", "GA-100-K-100"],
  [20, "", "GA-1K-K-1000"],
];

export function xlsxNum(v: unknown): number {
  const s = String(v ?? "").replace(/[,\s₩]/g, "");
  return s === "" ? 0 : Number(s) || 0;
}

// ── 재고 조정(실사) 대량 업로드 양식: SKU · 실사수량(목표) · 메모 ──
//  현재고를 '실사수량'이 되도록 조정(델타 = 실사수량 − 현재고)한다.
export const ADJUST_XLSX_HEADERS = ["SKU", "실사수량", "메모"] as const;
export const ADJUST_XLSX_EXAMPLE: (string | number)[][] = [
  ["GA-100-K-100", 850, "월말 실사"],
  ["P_DG-100X1", 120, ""],
];

// 엑셀 셀값 → 문자열(날짜/수식/리치텍스트 대응).
export function cellStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return "";
  }
  return String(v).trim();
}
