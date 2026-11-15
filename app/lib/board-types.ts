// 주요 지표(/board) — 서버가 저장하는 하루치 묶음의 모양과, 화면이 그 묶음에서 기간 값을 꺼내는 계산.
//  서버 전용 모듈을 불러오지 않는다(화면이 그대로 import).
//  묶음은 '날마다 한 칸' 배열(days 와 같은 길이, 과거 → 기준일)로 들고, 최근 7일·28일과 직전 같은 기간은 화면이 꼬리에서 잘라 더한다.
//  비율(객단가·ROAS·전환율)은 날마다의 비율을 평균하지 않고 기간 합계끼리 나눈다.

export const BOARD_DAYS = 56;            // 28일 + 직전 28일
export const BOARD_WINDOWS = [7, 28] as const;
export type BoardWindow = (typeof BOARD_WINDOWS)[number];

export type Fail = { ok: false; error: string };
export type NewRepeat = { total: number; newCust: number; repeatCust: number };

export type BoardSales = {
  ok: true;
  rev: number[]; orders: number[];
  channels: { name: string; rev: number[] }[];           // 56일 매출이 큰 순
  mtd: { from: string; to: string; rev: number; orders: number; prevFrom: string; prevTo: string; prevRev: number; prevOrders: number };
  cust: Record<BoardWindow, { cur: NewRepeat; prev: NewRepeat } | null>; // 신규·재구매 고객(기간 고유 고객 수라 날마다 더할 수 없다)
};
export type BoardMeta = { ok: true; spend: number[]; value: number[]; purchases: number[] };
export type BoardNaver = {
  ok: true; cost: number[];                               // VAT 포함 광고비
  purchaseSales: number[]; purchases: number[];           // 구매 전환(장바구니 제외)
  purchaseOk: boolean;                                    // false = 최근 7일 구매 전환을 다 받지 못함(ROAS 미확정)
};
export type BoardGa = {
  ok: true; sessions: number[]; users: number[]; purchases: number[];
  channels: Record<BoardWindow, { name: string; sessions: number; purchases: number }[]>;
};
export type BoardSub = {
  ok: true; asOf: string;
  active: (number | null)[]; pause: (number | null)[];    // 그날 스냅샷이 없으면 null
  newCnt: number[]; cancelCnt: number[];                  // 신청 단위 상태 변화(관측일 기준)
  subRev: number[];                                       // 정기배송 결제 주문 매출
};
export type BoardVoc = { ok: true; counts: number[] };

export type BoardSnapshot = {
  v: 1;
  base: string;            // 기준일 = 매출이 들어온 마지막 날(어제까지)
  builtAt: string;         // 계산 시각(ISO)
  builtDay: string;        // 계산한 날(KST)
  salesFp: string;         // 매출 지문 — 달라지면 다시 계산
  days: string[];          // YYYY-MM-DD × BOARD_DAYS
  sales: BoardSales | Fail;
  meta: BoardMeta | Fail | null;    // null = 연결 안 됨
  naver: BoardNaver | Fail | null;
  ga: BoardGa | Fail | null;
  sub: BoardSub | Fail;
  voc: BoardVoc | Fail;
};

// ── 화면 계산 ──
const tail = (xs: number[], n: number, skip = 0) => xs.slice(Math.max(0, xs.length - skip - n), xs.length - skip);
export const sumOf = (xs: number[]) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
/** 최근 n일 합계와 그 직전 n일 합계 */
export function windowSum(xs: number[], n: number): { cur: number; prev: number } {
  return { cur: sumOf(tail(xs, n)), prev: sumOf(tail(xs, n, n)) };
}
export const tailOf = <T,>(xs: T[], n: number): T[] => xs.slice(Math.max(0, xs.length - n));
/** 증감률(%) — 비교 값이 0 이하면 null */
export const pctChange = (cur: number, prev: number): number | null => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
/** 스냅샷 배열에서 '끝에서 back 칸 앞' 이하의 마지막 값(그날 값이 없으면 그 전 날) */
export function lastKnown(xs: (number | null)[], back = 0): number | null {
  for (let i = xs.length - 1 - back; i >= 0; i--) if (xs[i] != null) return xs[i] as number;
  return null;
}
