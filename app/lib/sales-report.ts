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
// 같은 기간 비교용 — 해/달을 옮길 때 없는 날짜(2/29·31일)는 그 달 말일로 당긴다.
//  당기지 않으면 JS Date 가 다음 달로 넘겨(3/31 → 3/3) 비교 구간이 통째로 틀어진다.
function shiftClamped(dt: Date, years: number, months: number): Date {
  const y = dt.getFullYear() + years;
  const mIdx = dt.getMonth() + months;                 // 0-based, 음수/12초과 정규화는 아래에서
  const ny = y + Math.floor(mIdx / 12);
  const nm = ((mIdx % 12) + 12) % 12;
  return new Date(ny, nm, Math.min(dt.getDate(), daysInMonth(ny, nm + 1)));
}

const WEEKDAY_KR = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"];

async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabaseAdmin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data || []) as T[];
}
const n = (v: unknown) => Number(v || 0);
// 코드가 만든 고정 집계문만 run_report(SELECT 전용·5,000행) 로 — 종합 리포트 runSql 과 같은 경로. 날짜는 iso() 산출값만 끼운다.
async function runQ<T = Record<string, unknown>>(q: string): Promise<T[]> {
  const { data, error } = await supabaseAdmin().rpc("run_report", { q, p_limit: 5000 });
  if (error) throw new Error(`집계 실패: ${error.message}`);
  return (Array.isArray(data) ? data : []) as T[];
}

// ── 2026-10-19 대표 결정: 매출 리포트는 종합 리포트가 다루지 않는 축을 맡는다 — 건수 × 객단가 분해, 상품 Top 10 순위 변동, 정기배송 ──
export type ChannelDecomp = { name: string; orders: number; revenue: number; aov: number; qty_per_order: number; prev_orders: number; prev_aov: number };
export type TopSku = { rank: number; code: string; name: string; revenue: number; qty: number; share: number; prev_rank: number | null };
export type SubscriptionFacts = {
  as_of: string; active: number; pause: number; total_members: number; lost: number;
  first_pay_rate: string; reach3_rate: string; cycle_mix: string;
  prev_as_of: string | null; prev_active: number | null;
  new_cnt: number; cancel_cnt: number; resume_cnt: number;             // 상태 변화(129) — 기간 안 관측분
  sub_revenue: number; sub_orders: number; sub_share: number;         // 기간(어제·금~일·주간) 정기배송 결제 주문 매출·비중
  sub_revenue_month: number | null; sub_share_month: number | null;   // 이번달 누적(일일만)
};

type DecompRow = { channel: string; orders: number; rev: number; qty: number };
async function channelDecomp(from: string, to: string): Promise<DecompRow[]> {
  return runQ<DecompRow>(`select channel, count(distinct order_id)::int as orders, coalesce(sum(subtotal_amount),0)::bigint as rev, coalesce(sum(quantity),0)::int as qty from sales_orders where order_date between '${from}' and '${to}' group by channel`);
}
function buildDecomp(cur: DecompRow[], prev: DecompRow[]): { rows: ChannelDecomp[]; total: ChannelDecomp } {
  const mk = (name: string, c?: DecompRow | null, p?: DecompRow | null): ChannelDecomp => {
    const o = n(c?.orders), r = n(c?.rev), q = n(c?.qty), po = n(p?.orders), pr = n(p?.rev);
    return { name, orders: o, revenue: r, aov: o ? Math.round(r / o) : 0, qty_per_order: o ? q / o : 0, prev_orders: po, prev_aov: po ? Math.round(pr / po) : 0 };
  };
  const names = [...new Set([...cur.map((r) => String(r.channel)), ...prev.map((r) => String(r.channel))])].filter(Boolean);
  const rows = names.map((nm) => mk(nm, cur.find((r) => String(r.channel) === nm), prev.find((r) => String(r.channel) === nm))).sort((a, b) => b.revenue - a.revenue);
  const sum = (rs: DecompRow[]): DecompRow => rs.reduce((a, r) => ({ channel: "", orders: a.orders + n(r.orders), rev: a.rev + n(r.rev), qty: a.qty + n(r.qty) }), { channel: "", orders: 0, rev: 0, qty: 0 });
  return { rows, total: mk("전체", sum(cur), sum(prev)) };
}

// SKU 하나에 채널마다 상품명이 달라(확인: P_DG-100X1 에 6개) 가장 많이 쓰인 이름을 대표로.
type TopRow = { sku_code: string; name: string; rev: number; qty: number };
async function topSkus(from: string, to: string, limit: number): Promise<TopRow[]> {
  return runQ<TopRow>(`select sku_code, mode() within group (order by product_name) as name, coalesce(sum(subtotal_amount),0)::bigint as rev, coalesce(sum(quantity),0)::int as qty from sales_orders where order_date between '${from}' and '${to}' and sku_code <> '' group by sku_code order by rev desc limit ${Math.max(1, Math.min(100, Math.floor(limit)))}`);
}
// prev = 비교 기간 상위 30(순위 변동용). null 이면 변동 표시 없음.
function buildTop(cur: TopRow[], prev: TopRow[] | null, total: number): TopSku[] {
  const prevRank = new Map<string, number>(prev ? prev.map((r, i) => [String(r.sku_code), i + 1]) : []);
  return cur.slice(0, 10).map((r, i) => ({
    rank: i + 1, code: String(r.sku_code), name: String(r.name || ""), revenue: n(r.rev), qty: n(r.qty),
    share: total > 0 ? n(r.rev) / total * 100 : 0, prev_rank: prev ? (prevRank.get(String(r.sku_code)) ?? null) : null,
  }));
}

// 정기배송 — 숫자는 정기배송 분석 화면과 같은 출처(subscription_snapshots 자동 스냅샷·상태 변화 로그 129), 매출은 결제 주문번호(127)로 매출 원장과 조인.
//  카페24 주문번호 형식(20261011-0000031)이 양쪽 같음을 확인(2026-10-19).
async function subRevenue(from: string, to: string): Promise<{ rev: number; orders: number }> {
  const r = await runQ<{ rev: number; orders: number }>(`select coalesce(sum(subtotal_amount),0)::bigint as rev, count(distinct order_id)::int as orders from sales_orders where order_date between '${from}' and '${to}' and order_id in (select order_id from cafe24_subscription_payments)`);
  return { rev: n(r[0]?.rev), orders: n(r[0]?.orders) };
}
type SnapRow = { data_date: string; snapshot: Record<string, unknown> };
async function snapshotAt(dateIso: string): Promise<SnapRow | null> {
  const { data, error } = await supabaseAdmin().from("subscription_snapshots").select("data_date, snapshot")
    .lte("data_date", dateIso).order("data_date", { ascending: false }).limit(1);
  if (error) throw new Error(`subscription_snapshots: ${error.message}`);
  return (data?.[0] as SnapRow | undefined) ?? null;
}
async function subscriptionFacts(o: { asOf: string; prevAsOf: string; logFrom: string; logTo: string; revFrom: string; revTo: string; revTotal: number; monthFrom?: string; monthTo?: string; monthTotal?: number }): Promise<SubscriptionFacts> {
  const [cur, prev, log, rev, revM] = await Promise.all([
    snapshotAt(o.asOf), snapshotAt(o.prevAsOf),
    runQ<{ kind: string; n: number }>(`select case when prev_state is null then 'new' when new_state = 'C' then 'cancel' when new_state = 'U' then 'resume' else 'other' end as kind, count(*)::int as n from cafe24_subscription_state_log where changed_on between '${o.logFrom}' and '${o.logTo}' group by 1`),
    subRevenue(o.revFrom, o.revTo),
    o.monthFrom && o.monthTo ? subRevenue(o.monthFrom, o.monthTo) : Promise.resolve(null),
  ]);
  if (!cur) throw new Error("정기배송 스냅샷이 없습니다. 정기배송 분석의 자동 수집을 확인하세요.");
  const s = cur.snapshot, str = (k: string) => String(s[k] ?? "-");
  const kind = (k: string) => n(log.find((r) => String(r.kind) === k)?.n);
  const hasPrev = !!prev && prev.data_date !== cur.data_date;
  return {
    as_of: cur.data_date, active: n(s.activeMembers), pause: n(s.pauseMembers), total_members: n(s.totalMembers), lost: n(s.lostMembers),
    first_pay_rate: str("firstPayRate"), reach3_rate: str("reach3Rate"), cycle_mix: str("cycleMix"),
    prev_as_of: hasPrev ? prev!.data_date : null, prev_active: hasPrev ? n(prev!.snapshot.activeMembers) : null,
    new_cnt: kind("new"), cancel_cnt: kind("cancel"), resume_cnt: kind("resume"),
    sub_revenue: rev.rev, sub_orders: rev.orders, sub_share: o.revTotal > 0 ? rev.rev / o.revTotal * 100 : 0,
    sub_revenue_month: revM ? revM.rev : null, sub_share_month: revM && o.monthTotal ? revM.rev / o.monthTotal * 100 : null,
  };
}
// 정기배송 표·로그가 없어도(127·129 미적용, 수집 중단) 매출 리포트는 나간다 — 섹션에 사유만 적는다.
async function subscriptionSafe(o: Parameters<typeof subscriptionFacts>[0]): Promise<{ subscription: SubscriptionFacts | null; subscription_error: string | null }> {
  try { return { subscription: await subscriptionFacts(o), subscription_error: null }; }
  catch (e) { return { subscription: null, subscription_error: (e as Error).message }; }
}

// 최신 매출일 = 오늘(KST) 이하 최신 주문일 — 미래 날짜 행(미리 발송완료한 도매, 연도 오타)을 기준일로 쓰지 않는다.
//  133 은 RPC 가 이미 미래를 뺀다. 미적용이면 미래 포함 max 가 오므로 오늘 이하 최신일을 직접 찾는다.
export async function maxOrderDate(): Promise<string | null> {
  const b = await rpc("sales_date_bounds", {});
  const max = b[0]?.max_date ? String(b[0].max_date) : null;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (!max || max <= today) return max;
  const { data, error } = await supabaseAdmin().from("sales_orders").select("order_date")
    .lte("order_date", today).order("order_date", { ascending: false }).limit(1);
  if (error) throw new Error(`sales_orders: ${error.message}`);
  return data?.[0]?.order_date ? String(data[0].order_date) : null;
}

export type ChannelCum = { name: string; year: number; last_year: number; month: number; prev_month: number };
export type DailyStats = {
  date_str: string; is_sunday: boolean; window_start: string; window_end: string;
  this_year_sales: number; last_year_sales: number; this_month_sales: number; prev_month_sales: number;
  month_runrate: number; year_runrate: number; month_rr_pct: number | null; year_rr_pct: number | null;
  // 실제 성장률 — 같은 기간끼리(올해 1/1~기준일 vs 작년 1/1~작년 같은 날 / 이번달 1일~기준일 vs 지난달 1일~같은 일자).
  //  위 rr_pct(전망)는 '남은 기간도 같은 속도'를 가정한 착지 예상이라 성장률과 다르다.
  ytd_sales: number; ytd_prev_sales: number; ytd_pct: number | null; ytd_prev_end: string;
  mtd_sales: number; mtd_prev_sales: number; mtd_pct: number | null; mtd_prev_start: string; mtd_prev_end: string;
  window_sales: number; prevday_sales: number | null;
  channels: string[]; channel_summary: Record<string, ChannelCum>; channel_window: Record<string, number>;
  top10: TopSku[];                       // 기간(어제·금~일) Top 10 — 상품명·수량·비중
  month_top10: TopSku[];                 // 이번달 누적 Top 10 — 지난달 같은 기간 순위 대비
  new_cust: number; repeat_cust: number; total_cust: number; new_ratio: number; repeat_ratio: number;
  unclassified_orders: number; unclassified_revenue: number;
  aov: number; order_count: number; max_order: number; min_order: number; max_order_codes: string; min_order_codes: string;
  day_breakdown: { label: string; date: string; revenue: number }[] | null;
  // 건수 × 객단가 — 기간 채널별, 비교 = 지난주 같은 요일(같은 길이 창을 7일 당김)
  decomp: ChannelDecomp[]; decomp_total: ChannelDecomp; decomp_prev_start: string; decomp_prev_end: string;
  mtd_orders: number; mtd_aov: number; mtd_prev_orders: number; mtd_prev_aov: number;
  subscription: SubscriptionFacts | null; subscription_error: string | null;
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

  const monthStart = iso(new Date(year, month - 1, 1));
  const pwStart = addDays(wStart, -7), pwEnd = addDays(wEnd, -7);   // 지난주 같은 요일(같은 길이 창)
  const [cum, chCum, chYtd, chMtd, winSum, chWin, nr, ext, prevSum, decCur, decPrev, topWin] = await Promise.all([
    rpc("sales_cumulative", { p_year: year, p_month: month }),
    rpc("sales_channel_cumulative", { p_year: year, p_month: month }),
    // 채널별 올해·이번달 누적은 기준일까지만(연·월 전체 RPC 는 기준일 뒤 매출까지 더한다)
    rpc("sales_channel_window", { p_from: `${year}-01-01`, p_to: iso(bd) }),
    rpc("sales_channel_window", { p_from: monthStart, p_to: iso(bd) }),
    rpc("sales_summary", { p_from: iso(wStart), p_to: iso(wEnd) }),
    rpc("sales_channel_window", { p_from: iso(wStart), p_to: iso(wEnd) }),
    rpc("sales_new_repeat", { p_from: iso(wStart), p_to: iso(wEnd) }),
    rpc("sales_order_extremes", { p_from: iso(wStart), p_to: iso(wEnd) }),
    isSunday ? Promise.resolve([]) : rpc("sales_summary", { p_from: iso(prevDate), p_to: iso(prevDate) }),
    channelDecomp(iso(wStart), iso(wEnd)),
    channelDecomp(iso(pwStart), iso(pwEnd)),
    topSkus(iso(wStart), iso(wEnd), 10),
  ]);

  // 실제 성장률 — 같은 길이 구간끼리. 누적 RPC(sales_cumulative)는 연/월 전체를 더하므로
  //  기준일보다 뒤의 데이터까지 섞일 수 있다. 여기서는 구간을 명시해 따로 집계한다.
  const lyEnd = shiftClamped(bd, -1, 0);
  const pmEnd = shiftClamped(bd, 0, -1);
  const [ytdCur, ytdPrev, mtdCur, mtdPrev] = await Promise.all([
    rpc("sales_summary", { p_from: `${year}-01-01`, p_to: iso(bd) }),
    rpc("sales_summary", { p_from: `${year - 1}-01-01`, p_to: iso(lyEnd) }),
    rpc("sales_summary", { p_from: monthStart, p_to: iso(bd) }),
    rpc("sales_summary", { p_from: iso(new Date(pmEnd.getFullYear(), pmEnd.getMonth(), 1)), p_to: iso(pmEnd) }),
  ]);
  const ytdSales = n(ytdCur[0]?.revenue), ytdPrevSales = n(ytdPrev[0]?.revenue);
  const mtdSales = n(mtdCur[0]?.revenue), mtdPrevSales = n(mtdPrev[0]?.revenue);
  const pmStart = iso(new Date(pmEnd.getFullYear(), pmEnd.getMonth(), 1));

  // 이번달 누적 Top 10(지난달 같은 기간 상위 30 과 순위 비교) + 정기배송
  const [topMonth, topPrevMonth, subs] = await Promise.all([
    topSkus(monthStart, iso(bd), 10),
    topSkus(pmStart, iso(pmEnd), 30),
    subscriptionSafe({
      asOf: iso(bd), prevAsOf: iso(addDays(bd, -7)), logFrom: iso(wStart), logTo: iso(wEnd),
      revFrom: iso(wStart), revTo: iso(wEnd), revTotal: n(winSum[0]?.revenue),
      monthFrom: monthStart, monthTo: iso(bd), monthTotal: mtdSales,
    }),
  ]);
  const decomp = buildDecomp(decCur, decPrev);

  const c = cum[0] || {};
  // 올해·이번달 누적과 런레이트 분자는 기준일까지(ytd·mtd) — 이른 기준일로 만들면 그 뒤 매출이 섞여 전망이 부풀던 것 수정.
  //  작년·지난달 '전체' 합은 비교 대상이라 연·월 전체 그대로.
  const thisYear = ytdSales, lastYear = n(c.last_year), thisMonth = mtdSales, prevMonth = n(c.prev_month);
  const monthRunrate = day > 0 ? thisMonth / day * daysInMonth(year, month) : 0;
  const yearDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;  // 윤년 인식(분모 dayOfYear도 윤년 반영)
  const yearRunrate = dayOfYear(bd) > 0 ? thisYear / dayOfYear(bd) * yearDays : 0;

  const channels = chCum.map((r) => String(r.channel)).filter(Boolean).sort();
  const channel_summary: Record<string, ChannelCum> = {};
  const ytdBy = new Map(chYtd.map((r) => [String(r.channel), n(r.revenue)]));
  const mtdBy = new Map(chMtd.map((r) => [String(r.channel), n(r.revenue)]));
  for (const r of chCum) channel_summary[String(r.channel)] = { name: String(r.channel), year: ytdBy.get(String(r.channel)) || 0, last_year: n(r.last_year), month: mtdBy.get(String(r.channel)) || 0, prev_month: n(r.prev_month) };
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
    ytd_sales: ytdSales, ytd_prev_sales: ytdPrevSales, ytd_pct: pct(ytdSales, ytdPrevSales), ytd_prev_end: iso(lyEnd),
    mtd_sales: mtdSales, mtd_prev_sales: mtdPrevSales, mtd_pct: pct(mtdSales, mtdPrevSales),
    mtd_prev_start: pmStart, mtd_prev_end: iso(pmEnd),
    window_sales: n(winSum[0]?.revenue), prevday_sales: isSunday ? null : n(prevSum[0]?.revenue),
    channels, channel_summary, channel_window,
    top10: buildTop(topWin, null, n(winSum[0]?.revenue)),
    month_top10: buildTop(topMonth, topPrevMonth, mtdSales),
    new_cust: newC, repeat_cust: repeatC, total_cust: total,
    new_ratio: total > 0 ? newC / total * 100 : 0, repeat_ratio: total > 0 ? repeatC / total * 100 : 0,
    unclassified_orders: n(nrr.unclassified_orders), unclassified_revenue: n(nrr.unclassified_revenue),
    aov: n(e.aov), order_count: n(e.order_count), max_order: n(e.max_order), min_order: n(e.min_order),
    max_order_codes: codesStr(maxCodes), min_order_codes: codesStr(minCodes),
    day_breakdown,
    decomp: decomp.rows, decomp_total: decomp.total, decomp_prev_start: iso(pwStart), decomp_prev_end: iso(pwEnd),
    mtd_orders: n(mtdCur[0]?.orders), mtd_aov: n(mtdCur[0]?.aov), mtd_prev_orders: n(mtdPrev[0]?.orders), mtd_prev_aov: n(mtdPrev[0]?.aov),
    ...subs,
    year, month, day,
  };
}

// ── 주간(월요일 실행 시) — 파이썬 analyze_and_build_weekly_report 1:1, 텍스트 본문 ──
export type WeeklyStats = {
  week_start: string; week_end: string; week_sales: number; prev_week_sales: number;
  channels: { name: string; week: number; prev_week: number }[];
  top10: TopSku[];                       // 이번 주 Top 10 — 전주 순위 대비
  new_cust: number; repeat_cust: number; total_cust: number; new_ratio: number; repeat_ratio: number;
  unclassified_orders: number; unclassified_revenue: number;
  aov: number; order_count: number; max_order: number; min_order: number; max_codes: string; min_codes: string;
  decomp: ChannelDecomp[]; decomp_total: ChannelDecomp;   // 건수 × 객단가 — 전주 대비
  subscription: SubscriptionFacts | null; subscription_error: string | null;
};

export async function computeWeeklyStats(baseIso: string): Promise<WeeklyStats> {
  const bd = d(baseIso);
  const wk = pyWeekday(bd);
  const weekStart = addDays(bd, -wk), weekEnd = addDays(weekStart, 6);
  const prevStart = addDays(weekStart, -7), prevEnd = addDays(weekStart, -1);

  const [wSum, pSum, chW, chP, topW, topP, nr, ext, decCur, decPrev] = await Promise.all([
    rpc("sales_summary", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    rpc("sales_summary", { p_from: iso(prevStart), p_to: iso(prevEnd) }),
    rpc("sales_channel_window", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    rpc("sales_channel_window", { p_from: iso(prevStart), p_to: iso(prevEnd) }),
    topSkus(iso(weekStart), iso(weekEnd), 10),
    topSkus(iso(prevStart), iso(prevEnd), 30),
    rpc("sales_new_repeat", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    rpc("sales_order_extremes", { p_from: iso(weekStart), p_to: iso(weekEnd) }),
    channelDecomp(iso(weekStart), iso(weekEnd)),
    channelDecomp(iso(prevStart), iso(prevEnd)),
  ]);
  const weekSales = n(wSum[0]?.revenue);
  const subs = await subscriptionSafe({
    asOf: iso(weekEnd), prevAsOf: iso(prevEnd), logFrom: iso(weekStart), logTo: iso(weekEnd),
    revFrom: iso(weekStart), revTo: iso(weekEnd), revTotal: weekSales,
  });
  const decomp = buildDecomp(decCur, decPrev);
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
    week_start: iso(weekStart), week_end: iso(weekEnd), week_sales: weekSales, prev_week_sales: n(pSum[0]?.revenue),
    channels: chNames.map((name) => ({ name, week: wMap.get(name) || 0, prev_week: prevMap.get(name) || 0 })),
    top10: buildTop(topW, topP, weekSales),
    decomp: decomp.rows, decomp_total: decomp.total, ...subs,
    new_cust: n(nrr.new_cust), repeat_cust: n(nrr.repeat_cust), total_cust: total,
    new_ratio: total > 0 ? n(nrr.new_cust) / total * 100 : 0, repeat_ratio: total > 0 ? n(nrr.repeat_cust) / total * 100 : 0,
    unclassified_orders: n(nrr.unclassified_orders), unclassified_revenue: n(nrr.unclassified_revenue),
    aov: n(e.aov), order_count: n(e.order_count), max_order: n(e.max_order), min_order: n(e.min_order), max_codes: codesStr(maxCodes), min_codes: codesStr(minCodes),
  };
}

// ── 텍스트 본문(파이썬 lines, HTML 미지원 대체본) ──
const won = (v: number) => `${Math.round(v).toLocaleString()}원`;
const pctChange = (c: number, p: number) => p === 0 ? (c === 0 ? "0%" : "신규") : (c > p ? `${((c - p) / p * 100).toFixed(1)}% 증가` : c < p ? `${(Math.abs(c - p) / p * 100).toFixed(1)}% 감소` : "변동 없음");
const diffMoney = (c: number, p: number) => c > p ? `${won(c - p)} 증가` : c < p ? `${won(p - c)} 감소` : "변동 없음";
const rankNote = (t: TopSku, prevLabel: string) => t.prev_rank === null ? `(${prevLabel} 순위 밖)` : t.prev_rank === t.rank ? `(${prevLabel} 같은 순위)` : `(${prevLabel} ${t.prev_rank}위)`;
const topLine = (t: TopSku, prevLabel: string | null) => `${t.rank}위 ${t.name || t.code}(${t.code}) ${t.qty}개 ${won(t.revenue)}, 비중 ${t.share.toFixed(1)}%${prevLabel ? ` ${rankNote(t, prevLabel)}` : ""}`;
function decompLines(rows: ChannelDecomp[], total: ChannelDecomp, curLabel: string, prevLabel: string): string[] {
  const L = [`${curLabel} 주문은 ${total.orders}건, 객단가 ${won(total.aov)}, 주문당 ${total.qty_per_order.toFixed(1)}개이며 ${prevLabel}은 주문 ${total.prev_orders}건, 객단가 ${won(total.prev_aov)}였습니다.`];
  for (const r of rows) L.push(`${r.name} 주문 ${r.orders}건(${prevLabel} ${r.prev_orders}건), 객단가 ${won(r.aov)}(${prevLabel} ${won(r.prev_aov)}), 주문당 ${r.qty_per_order.toFixed(1)}개.`);
  return L;
}
function subscriptionLines(s: SubscriptionFacts | null, err: string | null, periodLabel: string): string[] {
  if (!s) return [`정기배송: ${err || "데이터 없음"}`];
  const L = [`정기배송은 ${s.as_of} 기준 이용중 ${s.active}명${s.prev_active !== null ? `(${s.prev_as_of} ${s.prev_active}명)` : ""}, 일시정지 ${s.pause}명, 이탈 누적 ${s.lost}명(전체 ${s.total_members}명)입니다.`];
  L.push(`${periodLabel} 신규 ${s.new_cnt}건, 해지 ${s.cancel_cnt}건, 재개 ${s.resume_cnt}건이며, 정기배송 결제 주문 매출은 ${won(s.sub_revenue)}(${s.sub_orders}건, 비중 ${s.sub_share.toFixed(1)}%)${s.sub_revenue_month !== null ? `, 이번달 누적 ${won(s.sub_revenue_month)}(비중 ${(s.sub_share_month ?? 0).toFixed(1)}%)` : ""}입니다.`);
  L.push(`첫결제 전환 ${s.first_pay_rate}, 3회차 도달 ${s.reach3_rate}, 주기 믹스 ${s.cycle_mix}.`);
  return L;
}

export function buildDailyText(s: DailyStats): string {
  const L: string[] = [`씨몬스터 일일 매출 리포트 – ${s.date_str}`, ""];
  // 실제 성장률(같은 기간끼리) 먼저, 전망(연·월 환산)은 뒤에 — 둘을 섞어 읽지 않도록 문장을 분리.
  L.push(`올해 누적 매출은 ${won(s.this_year_sales)}이며, 작년 같은 기간(1/1~${s.ytd_prev_end.slice(5)}) ${won(s.ytd_prev_sales)} 대비 ${pctChange(s.ytd_sales, s.ytd_prev_sales)}했습니다.`);
  L.push(`지금 속도로 연말까지 가면 약 ${won(s.year_runrate)}으로, 작년 한 해 전체 ${won(s.last_year_sales)} 대비 ${pctChange(s.year_runrate, s.last_year_sales)}하는 흐름입니다.`);
  L.push(`이번달 누적 매출은 ${won(s.this_month_sales)}으로, 지난달 같은 기간(${s.mtd_prev_start.slice(5)}~${s.mtd_prev_end.slice(5)}) ${won(s.mtd_prev_sales)} 대비 ${pctChange(s.mtd_sales, s.mtd_prev_sales)}했습니다.`);
  L.push(`이 속도면 이번달은 약 ${won(s.month_runrate)}으로, 지난달 전체 ${won(s.prev_month_sales)} 대비 ${pctChange(s.month_runrate, s.prev_month_sales)}하는 흐름입니다.`, "");
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
  const wl = s.is_sunday ? "최근 3일(금~일)" : "어제";
  L.push("건수와 객단가로 나누면 다음과 같습니다.", ...decompLines(s.decomp, s.decomp_total, wl, `지난주 같은 요일(${s.decomp_prev_start.slice(5)}~${s.decomp_prev_end.slice(5)})`));
  L.push(`이번달 누적 주문은 ${s.mtd_orders}건, 객단가 ${won(s.mtd_aov)}이며 지난달 같은 기간은 ${s.mtd_prev_orders}건, ${won(s.mtd_prev_aov)}였습니다.`, "");
  if (s.top10.length) L.push(`${wl} 판매된 주요 상품(sku_code 기준) Top 10은 다음과 같습니다.`, ...s.top10.map((t) => topLine(t, null)));
  L.push("");
  if (s.month_top10.length) L.push(`이번달 누적 Top 10(지난달 같은 기간 순위 대비)은 다음과 같습니다.`, ...s.month_top10.map((t) => topLine(t, "지난달")));
  L.push("");
  L.push(`${s.is_sunday ? "최근 3일(금~일) 기준 " : ""}고객 분포는 신규 고객 ${s.new_cust}명(${s.new_ratio.toFixed(1)}%), 재구매 고객 ${s.repeat_cust}명(${s.repeat_ratio.toFixed(1)}%)${s.unclassified_orders > 0 ? `, 미분류 ${s.unclassified_orders}건(안심번호·무전화, 신규/재구매 제외)` : ""}였으며,`);
  L.push(`객단가는 ${won(s.aov)}이며, 최고매출건은 ${won(s.max_order)}(품목코드: ${s.max_order_codes}), 최저매출건은 ${won(s.min_order)}(품목코드: ${s.min_order_codes}) 입니다.`, "");
  L.push(...subscriptionLines(s.subscription, s.subscription_error, wl));
  return L.join("\n");
}

export function buildWeeklyText(s: WeeklyStats): string {
  const period = `${s.week_start} ~ ${s.week_end}`;
  const L: string[] = [`씨몬스터 주간 매출 리포트 – ${period}`, ""];
  L.push(`해당 주간(${period}) 총 매출은 ${won(s.week_sales)}이며, 전주 대비 ${pctChange(s.week_sales, s.prev_week_sales)}(전주 ${won(s.prev_week_sales)})입니다.`, "");
  L.push("채널별 주간 매출은 다음과 같습니다.", "");
  for (const c of s.channels) L.push(`${c.name} 주간 매출은 ${won(c.week)}이며, 전주 대비 ${pctChange(c.week, c.prev_week)}(전주 ${won(c.prev_week)})입니다.`);
  L.push("");
  L.push("건수와 객단가로 나누면 다음과 같습니다.", ...decompLines(s.decomp, s.decomp_total, "이번 주", "전주"), "");
  if (s.top10.length) L.push("이번 주 판매된 주요 상품(sku_code 기준) Top 10은 다음과 같습니다(전주 순위 대비).", ...s.top10.map((t) => topLine(t, "전주")));
  L.push("");
  L.push(`주간 고객 분포는 신규 고객 ${s.new_cust}명(${s.new_ratio.toFixed(1)}%), 재구매 고객 ${s.repeat_cust}명(${s.repeat_ratio.toFixed(1)}%)${s.unclassified_orders > 0 ? `, 미분류 ${s.unclassified_orders}건(안심번호·무전화, 신규/재구매 제외)` : ""}였으며,`);
  L.push(`주간 객단가는 ${won(s.aov)}이며, 최고매출건은 ${won(s.max_order)}(품목코드: ${s.max_codes}), 최저매출건은 ${won(s.min_order)}(품목코드: ${s.min_codes}) 입니다.`, "");
  L.push(...subscriptionLines(s.subscription, s.subscription_error, "이번 주"));
  return L.join("\n");
}
