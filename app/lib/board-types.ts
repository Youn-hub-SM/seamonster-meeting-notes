// 주요 지표(/board) — 서버가 저장하는 묶음의 모양과, 화면이 그 묶음에서 기간·필터 값을 꺼내는 계산.
//  서버 전용 모듈을 불러오지 않는다(화면이 그대로 import).
//  묶음은 '날마다 한 칸' 배열(days 와 같은 길이, 과거 → 기준일)로 들고, 고른 기간과 그 직전 같은 길이 기간은 화면이 잘라 더한다.
//  비율(객단가·ROAS·전환율)은 날마다의 비율을 평균하지 않고 기간 합계끼리 나눈다.

export const BOARD_DAYS = 180;           // 기간 선택 범위(직전 기간 비교까지 이 안에서)
export const BOARD_VERSION = 2;

export type Fail = { ok: false; error: string };
export type NewRepeat = { total: number; newCust: number; repeatCust: number };
export type Nullable = (number | null)[];   // null = 그날 값을 아직 받지 못함

export type BoardSales = {
  ok: true;
  channels: { name: string; rev: number[]; orders: number[] }[];   // 180일 매출이 큰 순. 합계는 화면이 고른 채널로 더한다
};
export type BoardMeta = { ok: true; spend: number[]; value: number[]; purchases: number[]; impressions: number[]; clicks: number[] }; // clicks = 링크 클릭
export type BoardNaver = {
  ok: true;
  cost: Nullable; impressions: Nullable; clicks: Nullable;   // VAT 포함 광고비. null = 아직 받지 못한 날(다음 계산 때 이어 받는다)
  purchaseSales: number[]; purchases: number[];              // 구매 전환(장바구니 제외)
  purchaseOk: boolean;                                       // false = 최근 7일 구매 전환을 다 받지 못함(ROAS 미확정)
};
export type BoardGa = { ok: true; channels: { name: string; sessions: number[]; purchases: number[] }[]; truncated: boolean };
export type BoardSub = {
  ok: true; asOf: string;
  active: Nullable; pause: Nullable;                         // 그날 스냅샷이 없으면 null
  newCnt: number[]; cancelCnt: number[];                     // 신청 단위 상태 변화(관측일 기준)
  subRev: number[];                                          // 정기배송 결제 주문 매출
};
export type BoardVoc = { ok: true; counts: number[] };

export type BoardSnapshot = {
  v: typeof BOARD_VERSION;
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

// 기간 상세(/api/board/detail) — 날마다 더할 수 없는 값(고유 고객 수)과 상품별 표
export type BoardProduct = { code: string; name: string; rev: number; qty: number; orders: number; prevRev: number };
export type BoardDetail = { from: string; to: string; products: BoardProduct[]; cust: { cur: NewRepeat; prev: NewRepeat } | null };

// ── 화면 계산 ──
export const shiftDay = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3) + 1;

/** 고른 기간의 배열 구간(i0~i1, 양끝 포함)과 직전 같은 길이 구간. 직전 구간이 묶음 밖이면 prev = null */
export type Span = { i0: number; i1: number; n: number; prev: { i0: number; i1: number } | null };
export function spanOf(days: string[], from: string, to: string): Span | null {
  const lo = days[0], hi = days[days.length - 1];
  const f = from < lo ? lo : from, t = to > hi ? hi : to;
  if (f > t) return null;
  const i0 = daysBetween(lo, f) - 1, i1 = daysBetween(lo, t) - 1, n = i1 - i0 + 1;
  return { i0, i1, n, prev: i0 - n >= 0 ? { i0: i0 - n, i1: i0 - 1 } : null };
}
export const sumOf = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (Number(x) || 0), 0);
export const cut = <T,>(xs: T[], i0: number, i1: number): T[] => xs.slice(i0, i1 + 1);
/** 기간 합계와 직전 기간 합계(직전이 없으면 prev = null) */
export function spanSum(xs: (number | null)[], sp: Span): { cur: number; prev: number | null } {
  return { cur: sumOf(cut(xs, sp.i0, sp.i1)), prev: sp.prev ? sumOf(cut(xs, sp.prev.i0, sp.prev.i1)) : null };
}
/** 여러 배열을 날마다 더한다 */
export function addSeries(list: (number | null)[][], len: number): number[] {
  const out = new Array<number>(len).fill(0);
  for (const xs of list) for (let i = 0; i < len; i++) out[i] += Number(xs[i]) || 0;
  return out;
}
/** 증감률(%) — 비교 값이 없거나 0 이하면 null */
export const pctChange = (cur: number | null, prev: number | null): number | null => (cur != null && prev != null && prev > 0 ? ((cur - prev) / prev) * 100 : null);
export const ratio = (a: number | null, b: number | null): number | null => (a != null && b != null && b > 0 ? a / b : null);
/** 스냅샷 배열에서 i 이하의 마지막 값(그날 값이 없으면 그 전 날) */
export function lastKnown(xs: Nullable, i: number): number | null {
  for (let k = Math.min(i, xs.length - 1); k >= 0; k--) if (xs[k] != null) return xs[k] as number;
  return null;
}
