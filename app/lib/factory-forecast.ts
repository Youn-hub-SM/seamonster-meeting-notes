// 파도소리 예상 화면 — 계산. 순수 함수(브라우저·서버 공용). 입력은 factory.flow_overview() 결과와 품명별 현재고.
//  방법의 근거: docs/factory-shipment-analysis.md 6장 · docs/factory-forecast-plan.md 4장.
//   - 전체(출고·창고 생산·매입)는 '최근 3개월 평균 × 계절 지수'로 숫자 하나.
//   - 품목은 숫자 하나로 못 맞힌다(오차 70~95%) → 창고에서 빠진 양의 '보통 ~ 많을 때' 범위와 목표 재고.

import type { FlowKind } from "./factory-flow";

export type FlowOverview = {
  first_date: string | null;
  last_date: string | null;
  uploaded_at: string | null;
  uploaded_by: string | null;
  monthly: [ym: string, kind: FlowKind, processed: boolean, big: boolean, kg: number][];
  weekly: [week: string, item: string, floor: number, ship: number][];
  item_monthly: [ym: string, item: string, out: number, prod: number][];
  last_prod: [item: string, date: string][];
  top_partner: [item: string, partner: string, kg: number, total: number][];
  order_daily: [date: string, kg: number][];
  big: [date: string, kind: FlowKind, item: string, partner: string, kg: number][];
  waste_kg: number;
};
export type FlowItemDetail = {
  monthly: [ym: string, prod: number, floor: number, ship: number, order: number][];
  partners: [partner: string, kg: number][];
};

export type ForecastSettings = { days: number; excluded: string[] };
export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = { days: 7, excluded: [] };
export const DAY_CHOICES = [3, 5, 7, 10, 14] as const;

export type SeriesKey = "ship" | "prod" | "buy";
export const SERIES_LABEL: Record<SeriesKey, string> = { ship: "출고", prod: "창고 생산", buy: "매입" };

export type SeriesForecast = {
  history: { ym: string; kg: number }[];           // 끝난 달(최근 24개월)
  next: { ym: string; kg: number }[];              // 앞으로 3개월(첫 달은 진행 중인 달일 수 있다)
  index: number[];                                 // 계절 지수(1월~12월)
  lastYear: (number | null)[];                     // next 각 달의 전년 같은 달 실적
};
export type ItemRow = {
  item: string;
  stock: number | null;        // pdsr.kr 현재고(kg) — 품명이 안 이어지면 null
  usual: number;               // 기준 일수 동안 보통 빠지는 양
  high: number;                // 기준 일수 동안 많을 때 빠지는 양(= 목표 재고)
  make: number | null;         // 생산 권장 = 목표 재고 − 현재고(0 이상). 현재고를 모르면 null
  floorShare: number;          // 빠진 양 중 현장으로 다시 올라간 비중(0~1) — 반제품 쓰임
  out12: number;               // 최근 12개월 창고에서 빠진 양
  prod12: number;              // 최근 12개월 창고 생산
  lastProd: string | null;
  crowd: { partner: string; share: number } | null; // 거래처 출고의 절반 이상을 한 곳이 가져가면
};
export type CheckRow = { label: string; forecast: number; actual: number };
export type ForecastResult = {
  lastDate: string;
  thisYm: string;                 // 진행 중인(또는 다음) 달
  thisMonthSoFar: Record<SeriesKey, number>;
  series: Record<SeriesKey, SeriesForecast>;
  items: ItemRow[];               // 꾸준히 빠지는 가공품(생산 권장 큰 순)
  restCount: number;              // 표에 올리지 않은 가공품 수
  restOut12: number;              // 그 품목들의 최근 12개월 빠진 양
  unlinked: number;               // 현재고를 못 이은 품목 수
  orderLoad: { day: string; avg: number; peak: number }[]; // 월~일
  check: { ym: string; totals: CheckRow[]; items: CheckRow[]; itemError: number | null };
  excluded: { date: string; kind: FlowKind; item: string; partner: string; kg: number }[];
  wasteKg: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
export function ymAdd(ym: string, n: number): string {
  const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
const monthOf = (ym: string) => Number(ym.slice(5, 7));
const dayAdd = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

// 계절 지수 — 해마다 '모든 해에 공통으로 끝난 달들'의 평균을 1 로 놓고, 달별 비율을 해에 걸쳐 평균한다.
//  (올해가 10월까지만 있으면 모든 해를 1~10월 평균으로 맞춰 비교한다 — 그래야 11·12월이 빠진 해가 높게 나오지 않는다)
//  끝난 달이 12개 미만이면 계절을 알 수 없으므로 전부 1.
export function seasonalIndex(series: Map<string, number>, firstYm: string, lastYm: string): number[] {
  const idx = Array<number>(12).fill(1);
  const months: string[] = [];
  for (let ym = firstYm; ym <= lastYm; ym = ymAdd(ym, 1)) months.push(ym);
  if (months.length < 12) return idx;
  const byYear = new Map<number, Set<number>>();
  for (const ym of months) {
    const y = Number(ym.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, new Set());
    byYear.get(y)!.add(monthOf(ym));
  }
  let years = [...byYear.keys()].sort();
  const common = () => Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => years.every((y) => byYear.get(y)!.has(m)));
  // 공통 달이 6개 미만이면 달이 가장 적은 해를 뺀다
  while (years.length > 1 && common().length < 6) {
    const drop = years.reduce((a, y) => (byYear.get(y)!.size < byYear.get(a)!.size ? y : a), years[0]);
    years = years.filter((y) => y !== drop);
  }
  const cm = common();
  if (cm.length < 6) return idx;
  const v = (y: number, m: number) => series.get(`${y}-${pad(m)}`) || 0;
  const base = new Map(years.map((y) => [y, mean(cm.map((m) => v(y, m)))] as const));
  for (let m = 1; m <= 12; m++) {
    const r = years.filter((y) => byYear.get(y)!.has(m) && (base.get(y) || 0) > 0).map((y) => v(y, m) / base.get(y)!);
    if (r.length) idx[m - 1] = mean(r) || 1;
  }
  return idx;
}

// 끝난 달 기준 '직전 3개월 평균 × 계절' 예상. at = 예상하려는 달, 그 앞 3개월을 쓴다.
function seasonalForecast(series: Map<string, number>, idx: number[], at: string, base: string): number {
  const level = mean([1, 2, 3].map((i) => { const ym = ymAdd(base, 1 - i); return (series.get(ym) || 0) / (idx[monthOf(ym) - 1] || 1); }));
  return level * (idx[monthOf(at) - 1] || 1);
}

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

export function computeForecast(ov: FlowOverview, stock: Record<string, number>, settings: ForecastSettings): ForecastResult | null {
  if (!ov.first_date || !ov.last_date) return null;
  const last = ov.last_date, first = ov.first_date;
  // 끝난 달: 마지막 날짜가 그 달 말일이면 그 달까지, 아니면 전달까지. 첫 달도 1일에 시작해야 끝난 달로 친다.
  const lastYm = dayAdd(last, 1).slice(0, 7) !== last.slice(0, 7) ? last.slice(0, 7) : ymAdd(last.slice(0, 7), -1);
  const firstYm = first.slice(8) === "01" ? first.slice(0, 7) : ymAdd(first.slice(0, 7), 1);
  const thisYm = ymAdd(lastYm, 1);

  // ── 전체 계열(월) ─ 출고는 대량 거래를 빼고, 창고 생산·매입은 대량도 평소 업무라 넣는다.
  //  다만 계절 지수는 대량을 뺀 값으로 만든다 — 큰 한 건이 든 달이 '성수기'로 잡히지 않게.
  const ser: Record<SeriesKey | "outP" | "prodCore" | "buyCore", Map<string, number>> =
    { ship: new Map(), prod: new Map(), buy: new Map(), outP: new Map(), prodCore: new Map(), buyCore: new Map() };
  const put = (k: keyof typeof ser, ym: string, kg: number) => ser[k].set(ym, (ser[k].get(ym) || 0) + kg);
  for (const [ym, kind, processed, big, kg] of ov.monthly) {
    if (kind === "ship_stock" || kind === "ship_order" || kind === "ship_etc") { if (!big) put("ship", ym, kg); }
    else if (kind === "prod_stock") { put("prod", ym, kg); if (!big) put("prodCore", ym, kg); }
    else if (kind === "buy") { put("buy", ym, kg); if (!big) put("buyCore", ym, kg); }
    if (processed && !big && (kind === "use_floor" || kind === "ship_stock")) put("outP", ym, kg);
  }
  const indexSrc: Record<SeriesKey, Map<string, number>> = { ship: ser.ship, prod: ser.prodCore, buy: ser.buyCore };
  const mkSeries = (k: SeriesKey): SeriesForecast => {
    const s = ser[k], index = seasonalIndex(indexSrc[k], firstYm, lastYm);
    const history: { ym: string; kg: number }[] = [];
    for (let ym = ymAdd(lastYm, -23) < firstYm ? firstYm : ymAdd(lastYm, -23); ym <= lastYm; ym = ymAdd(ym, 1)) history.push({ ym, kg: Math.round(s.get(ym) || 0) });
    const next = [0, 1, 2].map((i) => { const ym = ymAdd(thisYm, i); return { ym, kg: Math.round(seasonalForecast(s, index, ym, lastYm)) }; });
    const lastYear = next.map((n) => { const ym = ymAdd(n.ym, -12); return ym >= firstYm && ym <= lastYm ? Math.round(s.get(ym) || 0) : null; });
    return { history, next, index, lastYear };
  };
  const series = { ship: mkSeries("ship"), prod: mkSeries("prod"), buy: mkSeries("buy") };
  const thisMonthSoFar = {
    ship: Math.round(ser.ship.get(thisYm) || 0), prod: Math.round(ser.prod.get(thisYm) || 0), buy: Math.round(ser.buy.get(thisYm) || 0),
  };

  // ── 창고 가공품 ─ 최근 52주(끝난 주)의 주별 빠진 양에서 계절을 걷어내고 가운데 값·위 20% 값을 본다
  const idxOut = seasonalIndex(ser.outP, firstYm, lastYm);
  const weekDay = (new Date(`${last}T00:00:00Z`).getUTCDay() + 6) % 7;          // 월=0
  const lastWeek = dayAdd(last, weekDay === 6 ? -6 : -weekDay - 7);              // 마지막으로 끝난 주의 월요일
  const weeks: string[] = [];
  for (let i = 51; i >= 0; i--) weeks.push(dayAdd(lastWeek, -7 * i));
  const weekPos = new Map(weeks.map((w, i) => [w, i] as const));
  const perItem = new Map<string, { w: number[]; floor: number; ship: number }>();
  for (const [wk, item, floor, ship] of ov.weekly) {
    const i = weekPos.get(wk);
    if (i == null) continue;
    let a = perItem.get(item);
    if (!a) perItem.set(item, (a = { w: Array<number>(52).fill(0), floor: 0, ship: 0 }));
    a.w[i] += (floor + ship) / (idxOut[Number(wk.slice(5, 7)) - 1] || 1);
    a.floor += floor; a.ship += ship;
  }
  const months12: string[] = Array.from({ length: 12 }, (_, i) => ymAdd(lastYm, -i));
  const im = new Map<string, Map<string, { out: number; prod: number }>>();
  for (const [ym, item, out, prod] of ov.item_monthly) {
    if (!im.has(item)) im.set(item, new Map());
    im.get(item)!.set(ym, { out, prod });
  }
  const lastProd = new Map(ov.last_prod);
  const crowd = new Map(ov.top_partner.map(([item, partner, kg, total]) => [item, { partner, share: total > 0 ? kg / total : 0 }] as const));
  const nowIdx = idxOut[Number(dayAdd(last, 1).slice(5, 7)) - 1] || 1;
  const scale = (nowIdx * settings.days) / 7;
  const excludedItems = new Set(settings.excluded);

  const items: ItemRow[] = [];
  let restCount = 0, restOut12 = 0, unlinked = 0;
  for (const [item, mm] of im) {
    const out12 = months12.reduce((s, ym) => s + (mm.get(ym)?.out || 0), 0);
    if (out12 <= 0) continue;
    const active = months12.filter((ym) => (mm.get(ym)?.out || 0) > 0).length;
    // 꾸준히 빠지는 품목만 표에 올린다(최근 12개월 중 11개월 이상) — 나머지는 합계 한 줄
    if (active < 11 || excludedItems.has(item)) { restCount++; restOut12 += out12; continue; }
    const a = perItem.get(item) || { w: Array<number>(52).fill(0), floor: 0, ship: 0 };
    const sorted = [...a.w].sort((x, y) => x - y);
    const usual = quantile(sorted, 0.5) * scale, high = quantile(sorted, 0.8) * scale;
    const st = item in stock ? stock[item] : null;
    if (st == null) unlinked++;
    const c = crowd.get(item);
    items.push({
      item, stock: st,
      usual: Math.round(usual), high: Math.round(high),
      make: st == null ? null : Math.max(0, Math.round(high - st)),
      floorShare: a.floor + a.ship > 0 ? a.floor / (a.floor + a.ship) : 0,
      out12: Math.round(out12),
      prod12: Math.round(months12.reduce((s, ym) => s + (mm.get(ym)?.prod || 0), 0)),
      lastProd: lastProd.get(item) || null,
      crowd: c && c.share >= 0.5 ? c : null,
    });
  }
  // 생산 권장이 큰 순 → 재고를 모르는 품목은 목표 재고 큰 순으로 그 뒤
  items.sort((x, y) => (y.make ?? -1) - (x.make ?? -1) || y.high - x.high);

  // ── 주문 생산 부하 ─ 최근 8주, 요일별 평균과 가장 많았던 날
  const byDay = new Map(ov.order_daily);
  const load = WEEKDAYS.map((day) => ({ day, vals: [] as number[] }));
  for (let i = 0; i < 56; i++) {
    const d = dayAdd(last, -i);
    load[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7].vals.push(Math.max(0, byDay.get(d) || 0));
  }
  const orderLoad = load.map((l) => ({ day: l.day, avg: Math.round(mean(l.vals)), peak: Math.round(Math.max(0, ...l.vals)) }));

  // ── 지난 예상 확인 ─ 마지막으로 끝난 달을, 그 전달까지만 보고 냈을 예상과 견준다
  const prevYm = ymAdd(lastYm, -1);
  const enough = ymAdd(lastYm, -3) >= firstYm;
  const totals: CheckRow[] = enough ? (["ship", "prod", "buy"] as SeriesKey[]).map((k) => ({
    label: SERIES_LABEL[k],
    forecast: Math.round(seasonalForecast(ser[k], series[k].index, lastYm, prevYm)),
    actual: Math.round(ser[k].get(lastYm) || 0),
  })) : [];
  const checkItems: CheckRow[] = enough ? items.map((r) => {
    const s = new Map([...im.get(r.item)!].map(([ym, v]) => [ym, v.out] as const));
    return { label: r.item, forecast: Math.round(seasonalForecast(s, idxOut, lastYm, prevYm)), actual: Math.round(s.get(lastYm) || 0) };
  }).sort((x, y) => y.actual - x.actual) : [];
  const actualSum = checkItems.reduce((s, r) => s + r.actual, 0);
  const itemError = actualSum > 0 ? checkItems.reduce((s, r) => s + Math.abs(r.forecast - r.actual), 0) / actualSum : null;

  // 실제로 예상에서 빠진 대량 거래: 출고 전부 + 가공품의 현장 출고·창고 생산(품목 표에서 빠짐)
  const excluded = ov.big
    .filter(([, kind]) => kind === "ship_stock" || kind === "ship_order" || kind === "ship_etc")
    .map(([date, kind, item, partner, kg]) => ({ date, kind, item, partner, kg }));

  return {
    lastDate: last, thisYm, thisMonthSoFar, series, items,
    restCount, restOut12: Math.round(restOut12), unlinked, orderLoad,
    check: { ym: lastYm, totals, items: checkItems, itemError },
    excluded, wasteKg: ov.waste_kg || 0,
  };
}
