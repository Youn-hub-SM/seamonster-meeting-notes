// 매출 리포트 계산 — 집계 RPC를 소비해 일일/주간 stats 조립(파이썬 analyze_and_build_* 1:1).
//  run-rate(30일·연 환산) 비교식 보존. 서버 전용(supabaseAdmin).
import { supabaseAdmin } from "./supabase";

// ── 날짜 유틸(로컬 자정 기준, KST 데이터는 date문자열이라 TZ 무관) ──
function d(iso: string): Date { const [y, m, dd] = iso.split("-").map(Number); return new Date(y, m - 1, dd); }
function iso(dt: Date): string { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`; }
function addDays(dt: Date, n: number): Date { const x = new Date(dt); x.setDate(x.getDate() + n); return x; }
function pyWeekday(dt: Date): number { return (dt.getDay() + 6) % 7; }   // Mon=0..Sun=6
function daysInMonth(y: number, m: number): number { return new Date(y, m, 0).getDate(); }
function dayOfYear(dt: Date): number { return Math.floor((Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) - Date.UTC(dt.getFullYear(), 0, 0)) / 86400_000); }

const WEEKDAY_KR = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"];

async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabaseAdmin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data || []) as T[];
}
const n = (v: unknown) => Number(v || 0);

export async function maxOrderDate(): Promise<string | null> {
  const b = await rpc("sales_date_bounds", {});
  return b[0]?.max_date ? String(b[0].max_date) : null;
}

export type ChannelCum = { name: string; year: number; last_year: number; month: number; prev_month: number };
export type DailyStats = {
  date_str: string; is_sunday: boolean; window_start: string; window_end: string;
  this_year_sales: number; last_year_sales: number; this_month_sales: number; prev_month_sales: number;
  month_runrate: number; year_runrate: number; month_rr_pct: number | null; year_rr_pct: number | null;
  window_sales: number; prevday_sales: number | null;
  channels: string[]; channel_summary: Record<string, ChannelCum>; channel_window: Record<string, number>;
  top10: { rank: number; code: string; revenue: number }[];
  new_cust: number; repeat_cust: number; total_cust: number; new_ratio: number; repeat_ratio: number;
  aov: number; order_count: number; max_order: number; min_order: number; max_order_codes: string; min_order_codes: string;
  day_breakdown: { label: string; date: string; revenue: number }[] | null;
  year: number; month: number; day: number;
};

const pct = (c: number, p: number): number | null => (p === 0 ? null : (c - p) / p * 100);

export async function computeDailyStats(baseIso?: string): Promise<DailyStats> {
  const base = baseIso || (await maxOrderDate());
  if (!base) throw new Error("매출 데이터가 없습니다.");
  const bd = d(base);
  const isSunday = bd.getDay() === 0;
  const wStart = isSunday ? addDays(bd, -2) : bd;   // 일요일이면 금~일
  const wEnd = bd;
  const year = bd.getFullYear(), month = bd.getMonth() + 1, day = bd.getDate();
  const prevDate = addDays(bd, -1);

  const [cum, chCum, winSum, chWin, top, nr, ext, prevSum] = await Promise.all([
    rpc("sales_cumulative", { p_year: year, p_month: month }),
    rpc("sales_channel_cumulative", { p_year: year, p_month: month }),
    rpc("sales_summary", { p_from: iso(wStart), p_to: iso(wEnd) }),
    rpc("sales_channel_window", { p_from: iso(wStart), p_to: iso(wEnd) }),
    rpc("sales_top_sku", { p_from: iso(wStart), p_to: iso(wEnd), p_limit: 10 }),
    rpc("sales_new_repeat", { p_from: iso(wStart), p_to: iso(wEnd) }),
    rpc("sales_order_extremes", { p_from: iso(wStart), p_to: iso(wEnd) }),
    isSunday ? Promise.resolve([]) : rpc("sales_summary", { p_from: iso(prevDate), p_to: iso(prevDate) }),
  ]);

  const c = cum[0] || {};
  const thisYear = n(c.this_year), lastYear = n(c.last_year), thisMonth = n(c.this_month), prevMonth = n(c.prev_month);
  const monthRunrate = day > 0 ? thisMonth / day * daysInMonth(year, month) : 0;
  const yearDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;  // 윤년 인식(분모 dayOfYear도 윤년 반영)
  const yearRunrate = dayOfYear(bd) > 0 ? thisYear / dayOfYear(bd) * yearDays : 0;

  const channels = chCum.map((r) => String(r.channel)).filter(Boolean).sort();
  const channel_summary: Record<string, ChannelCum> = {};
  for (const r of chCum) channel_summary[String(r.channel)] = { name: String(r.channel), year: n(r.this_year), last_year: n(r.last_year), month: n(r.this_month), prev_month: n(r.prev_month) };
  const channel_window: Record<string, number> = {};
  for (const r of chWin) channel_window[String(r.channel)] = n(r.revenue);

  const e = ext[0] || {};
  const [maxCodes, minCodes] = await Promise.all([
    e.max_order_id ? rpc("sales_order_skus", { p_order_id: String(e.max_order_id) }) : Promise.resolve([]),
    e.min_order_id ? rpc("sales_order_skus", { p_order_id: String(e.min_order_id) }) : Promise.resolve([]),
  ]);
  const codesStr = (rows: { sku_code?: unknown }[]) => rows.map((r) => String(r.sku_code)).filter(Boolean).join(", ") || "-";

  const nrr = nr[0] || {};
  const total = n(nrr.total), newC = n(nrr.new_cust), repeatC = n(nrr.repeat_cust);

  let day_breakdown: DailyStats["day_breakdown"] = null;
  if (isSunday) {
    const bk = await rpc("sales_daily_breakdown", { p_from: iso(wStart), p_to: iso(wEnd) });
    const map = new Map(bk.map((r) => [String(r.d), n(r.revenue)]));
    day_breakdown = [0, 1, 2].map((i) => { const dt = addDays(wStart, i); return { label: WEEKDAY_KR[pyWeekday(dt)], date: iso(dt), revenue: map.get(iso(dt)) || 0 }; });
  }

  return {
    date_str: base, is_sunday: isSunday, window_start: iso(wStart), window_end: iso(wEnd),
    this_year_sales: thisYear, last_year_sales: lastYear, this_month_sales: thisMonth, prev_month_sales: prevMonth,
    month_runrate: monthRunrate, year_runrate: yearRunrate, month_rr_pct: pct(monthRunrate, prevMonth), year_rr_pct: pct(yearRunrate, lastYear),
    window_sales: n(winSum[0]?.revenue), prevday_sales: isSunday ? null : n(prevSum[0]?.revenue),
    channels, channel_summary, channel_window,
    top10: top.map((t, i) => ({ rank: i + 1, code: String(t.sku_code), revenue: n(t.revenue) })),
    new_cust: newC, repeat_cust: repeatC, total_cust: total,
    new_ratio: total > 0 ? newC / total * 100 : 0, repeat_ratio: total > 0 ? repeatC / total * 100 : 0,
    aov: n(e.aov), order_count: n(e.order_count), max_order: n(e.max_order), min_order: n(e.min_order),
    max_order_codes: codesStr(maxCodes), min_order_codes: codesStr(minCodes),
    day_breakdown, year, month, day,
  };
}

// ── 주간(월요일 실행 시) — 파이썬 analyze_and_build_weekly_report 1:1, 텍스트 본문 ──
export type WeeklyStats = {
  week_start: string; week_end: string; week_sales: number; prev_week_sales: number;
  channels: { name: string; week: number; prev_week: number }[];
  top10: { rank: number; code: string; revenue: number }[];
  new_cust: number; repeat_cust: number; total_cust: number; new_ratio: number; repeat_ratio: number;
  aov: number; max_order: number; min_order: number; max_codes: string; min_codes: string;
};

export async function computeWeeklyStats(baseIso: string): Promise<WeeklyStats> {
  const bd = d(baseIso);
  const wk = pyWeekday(bd);
  const weekStart = addDays(bd, -wk), weekEnd = addDays(weekStart, 6);
  const prevStart = addDays(weekStart, -7), prevEnd = addDays(weekStart, -1);

  const [wSum, pSum, chW, chP, top, nr, ext] = await Promise.all([
    rpc("sales_summary", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    rpc("sales_summary", { p_from: iso(prevStart), p_to: iso(prevEnd) }),
    rpc("sales_channel_window", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    rpc("sales_channel_window", { p_from: iso(prevStart), p_to: iso(prevEnd) }),
    rpc("sales_top_sku", { p_from: iso(weekStart), p_to: iso(weekEnd), p_limit: 10 }),
    rpc("sales_new_repeat", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    rpc("sales_order_extremes", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
  ]);
  const prevMap = new Map(chP.map((r) => [String(r.channel), n(r.revenue)]));
  const chNames = [...new Set([...chW.map((r) => String(r.channel)), ...chP.map((r) => String(r.channel))])].filter(Boolean).sort();
  const e = ext[0] || {};
  const [maxCodes, minCodes] = await Promise.all([
    e.max_order_id ? rpc("sales_order_skus", { p_order_id: String(e.max_order_id) }) : Promise.resolve([]),
    e.min_order_id ? rpc("sales_order_skus", { p_order_id: String(e.min_order_id) }) : Promise.resolve([]),
  ]);
  const codesStr = (rows: { sku_code?: unknown }[]) => rows.map((r) => String(r.sku_code)).filter(Boolean).join(", ") || "-";
  const wMap = new Map(chW.map((r) => [String(r.channel), n(r.revenue)]));
  const nrr = nr[0] || {}, total = n(nrr.total);

  return {
    week_start: iso(weekStart), week_end: iso(weekEnd), week_sales: n(wSum[0]?.revenue), prev_week_sales: n(pSum[0]?.revenue),
    channels: chNames.map((name) => ({ name, week: wMap.get(name) || 0, prev_week: prevMap.get(name) || 0 })),
    top10: top.map((t, i) => ({ rank: i + 1, code: String(t.sku_code), revenue: n(t.revenue) })),
    new_cust: n(nrr.new_cust), repeat_cust: n(nrr.repeat_cust), total_cust: total,
    new_ratio: total > 0 ? n(nrr.new_cust) / total * 100 : 0, repeat_ratio: total > 0 ? n(nrr.repeat_cust) / total * 100 : 0,
    aov: n(e.aov), max_order: n(e.max_order), min_order: n(e.min_order), max_codes: codesStr(maxCodes), min_codes: codesStr(minCodes),
  };
}

// ── 텍스트 본문(파이썬 lines, HTML 미지원 대체본) ──
const won = (v: number) => `${Math.round(v).toLocaleString()}원`;
const pctChange = (c: number, p: number) => p === 0 ? (c === 0 ? "0%" : "신규") : (c > p ? `${((c - p) / p * 100).toFixed(1)}% 증가` : c < p ? `${(Math.abs(c - p) / p * 100).toFixed(1)}% 감소` : "변동 없음");
const diffMoney = (c: number, p: number) => c > p ? `${won(c - p)} 증가` : c < p ? `${won(p - c)} 감소` : "변동 없음";

export function buildDailyText(s: DailyStats): string {
  const L: string[] = [`씨몬스터 일일 매출 리포트 – ${s.date_str}`, ""];
  L.push(`올해 누적 매출은 ${won(s.this_year_sales)}이며, 전년 대비 ${pctChange(s.this_year_sales, s.last_year_sales)}(전년 누적 ${won(s.last_year_sales)})했습니다.`);
  L.push(`이번달 누적 매출은 ${won(s.this_month_sales)}으로, 전달 대비 ${pctChange(s.this_month_sales, s.prev_month_sales)}(전월 누적 ${won(s.prev_month_sales)})했습니다.`, "");
  L.push("채널별 매출은 다음과 같습니다.", "");
  for (const ch of s.channels) { const cs = s.channel_summary[ch]; L.push(`${ch}은 올해 누적 매출 ${won(cs.year)}로 전년 대비 ${pctChange(cs.year, cs.last_year)}(전년 누적 ${won(cs.last_year)})였으며, 이번달 누적 매출은 ${won(cs.month)}으로 전달 대비 ${pctChange(cs.month, cs.prev_month)}(전월 누적 ${won(cs.prev_month)})였습니다.`, ""); }
  if (!s.is_sunday) {
    L.push(`어제 매출(기준일 ${s.date_str})은 ${won(s.window_sales)}이며, 전일 대비 ${diffMoney(s.window_sales, s.prevday_sales ?? 0)}였습니다.`);
    const cw = Object.entries(s.channel_window).sort((a, b) => b[1] - a[1]);
    L.push(cw.length ? `채널별로는 ${cw.map(([c, v]) => `${c} ${won(v)}`).join(", ")} 순입니다.` : "채널별 일매출 데이터가 없습니다.");
  } else {
    L.push(`이번 주말(금요일~일요일, ${s.window_start}~${s.window_end}) 매출 합계는 ${won(s.window_sales)}입니다.`);
    if (s.day_breakdown) L.push("일별로는 " + s.day_breakdown.map((x) => `${x.label} ${won(x.revenue)}`).join(", ") + "입니다.");
  }
  L.push("");
  if (s.top10.length) L.push(`${s.is_sunday ? "최근 3일(금~일)" : "어제"} 판매된 주요 상품(sku_code 기준) Top 10은 다음과 같습니다.`, s.top10.map((t) => `${t.rank}위 ${t.code} ${won(t.revenue)}`).join(", ") + " …");
  L.push("");
  L.push(`${s.is_sunday ? "최근 3일(금~일) 기준 " : ""}고객 분포는 신규 고객 ${s.new_cust}명(${s.new_ratio.toFixed(1)}%), 재구매 고객 ${s.repeat_cust}명(${s.repeat_ratio.toFixed(1)}%)였으며,`);
  L.push(`객단가는 ${won(s.aov)}이며, 최고매출건은 ${won(s.max_order)}(품목코드: ${s.max_order_codes}), 최저매출건은 ${won(s.min_order)}(품목코드: ${s.min_order_codes}) 입니다.`);
  return L.join("\n");
}

export function buildWeeklyText(s: WeeklyStats): string {
  const period = `${s.week_start} ~ ${s.week_end}`;
  const L: string[] = [`씨몬스터 주간 매출 리포트 – ${period}`, ""];
  L.push(`해당 주간(${period}) 총 매출은 ${won(s.week_sales)}이며, 전주 대비 ${pctChange(s.week_sales, s.prev_week_sales)}(전주 ${won(s.prev_week_sales)})입니다.`, "");
  L.push("채널별 주간 매출은 다음과 같습니다.", "");
  for (const c of s.channels) L.push(`${c.name} 주간 매출은 ${won(c.week)}이며, 전주 대비 ${pctChange(c.week, c.prev_week)}(전주 ${won(c.prev_week)})입니다.`);
  L.push("");
  if (s.top10.length) L.push("이번 주 판매된 주요 상품(sku_code 기준) Top 10은 다음과 같습니다.", s.top10.map((t) => `${t.rank}위 ${t.code} ${won(t.revenue)}`).join(", ") + " …");
  L.push("");
  L.push(`주간 고객 분포는 신규 고객 ${s.new_cust}명(${s.new_ratio.toFixed(1)}%), 재구매 고객 ${s.repeat_cust}명(${s.repeat_ratio.toFixed(1)}%)였으며,`);
  L.push(`주간 객단가는 ${won(s.aov)}이며, 최고매출건은 ${won(s.max_order)}(품목코드: ${s.max_codes}), 최저매출건은 ${won(s.min_order)}(품목코드: ${s.min_codes}) 입니다.`);
  return L.join("\n");
}
