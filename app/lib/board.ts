// 주요 지표(/board, 2026-11-15) — 매출·주문 / 광고·유입 / 정기배송·고객을 한 묶음으로 모아 b2b_settings 에 저장한다. 서버 전용.
//  (주제 보고서 = 조건으로 정의한 주제 하나의 묶음은 board-topic.ts — 이 파일의 기준일·매출 지문을 같이 쓴다.)
//  · 묶음 = 최근 180일의 날마다 값. 화면이 기간·필터를 바꿔도 서버를 다시 부르지 않고 이 묶음에서 잘라 쓴다.
//  · 하루 한 번: 그날 처음 화면을 열 때 계산한다(예약 신호·크론 없음). 그 뒤에는 저장된 묶음을 그대로 준다.
//  · 매출이 새로 들어오면(지문이 달라지면) 다시 계산한다 — 아침에 연 묶음이 매출 업로드 전 숫자로 하루 종일 남지 않게.
//  · 기준일 = 매출이 들어온 마지막 날(어제까지). 모든 구역이 같은 기준일·같은 180일을 쓴다.
//  · 구역 하나가 실패해도 나머지는 나간다(구역마다 ok/error). 외부 조회(메타·네이버·GA)에는 시간 상한을 둔다.
//  · 네이버 광고비는 하루에 요청 한 번이라 180일을 한꺼번에 받지 않는다 — 지난 묶음의 값을 이어 쓰고, 없는 날만 최근부터 받는다.
//  숫자 기준은 기존 화면과 같다: 매출 = sales_orders.subtotal_amount(도매 포함), 주문 건수 = 주문 1건 키(order_unit),
//   메타 ROAS = 구매액 ÷ 지출, 네이버 ROAS = 구매 전환 매출 ÷ VAT 제외 광고비, 정기배송 = subscription_snapshots·상태 변화 로그(129).
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { ORDER_UNIT_SQL } from "./sales-order-unit";
import { fetchAllPages } from "./sales-paging";
import { readKvSoft, mutateKv } from "./production-kv";
import { isMetaAdConfigured, getAccountDaily, getInsightSeries } from "./meta-ad";
import { isNaverAdConfigured, listCampaigns, getStats } from "./naver-ad";
import { getPurchaseConversions } from "./naver-conv";
import { isGaConfigured, runGaReport } from "./ga";
import { BOARD_DAYS, BOARD_VERSION, shiftDay as shift, daysBetween, type BoardSnapshot, type BoardSales, type BoardMeta, type BoardNaver, type BoardGa, type BoardSub, type BoardVoc, type BoardDetail, type BoardProduct, type Fail, type NewRepeat, type Nullable } from "./board-types";

const KV_SNAPSHOT = "board_snapshot";
const KV_BUILD = "board_build";
const LOCK_MS = 3 * 60_000;        // 계산 중 표시가 이보다 오래되면 죽은 실행으로 본다
const AUTO_GAP_MS = 10 * 60_000;   // 매출 지문이 달라져도 이 간격 안에는 다시 계산하지 않는다
const MANUAL_GAP_MS = 60_000;      // [다시 계산] 연타 방지
const NAVER_REFRESH_DAYS = 3;      // 최근 며칠은 값이 늦게 굳어 매번 다시 받는다
const NAVER_BUDGET_MS = 50_000;    // 네이버 광고비를 받는 데 쓰는 시간 — 남은 날은 다음 계산 때 이어 받는다
const GA_TOP_CHANNELS = 9;         // 유입 채널은 방문이 많은 9곳 + 기타

export class BoardBusy extends Error { constructor(msg: string) { super(msg); this.name = "BoardBusy"; } }

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v) || 0;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message?: unknown }).message) : String(e));
const fail = (e: unknown): Fail => ({ ok: false, error: errMsg(e).slice(0, 200) });
const timeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 조회 시간 초과(${Math.round(ms / 1000)}초)`)), ms))]);
const zeros = (n: number) => new Array<number>(n).fill(0);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHANNEL_RE = /^[가-힣A-Za-z0-9 _()\-]{1,30}$/;
const RUN_LIMIT = 5000;

async function runQ<T>(sb: SupabaseClient, q: string): Promise<T[]> {
  const { data, error } = await sb.rpc("run_report", { q, p_limit: RUN_LIMIT });
  if (error) throw new Error(`집계 실패: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as T[];
  if (rows.length >= RUN_LIMIT) throw new Error("집계 결과가 5,000행을 넘어 잘렸습니다."); // 잘린 결과로 합계를 내지 않는다
  return rows;
}

// ── 매출 지문·기준일 ── 최근 10일의 마지막 주문일과 줄 수. 오늘 주문이 들어와 있어도 기준일은 어제까지.
export async function salesFingerprint(sb: SupabaseClient): Promise<{ fp: string; base: string }> {
  const today = kstToday(), yesterday = shift(today, -1);
  const r = await runQ<{ mx: string | null; n: number }>(sb, `select max(order_date)::text as mx, count(*)::int as n from sales_orders where order_date between '${shift(today, -10)}' and '${today}'`);
  const mx = r[0]?.mx ? String(r[0].mx) : "";
  return { fp: `${mx}:${num(r[0]?.n)}`, base: mx && mx < yesterday ? mx : yesterday };
}

// ── 매출·주문 ── 날짜 × 채널. 합계는 화면이 고른 채널로 더한다.
async function salesSection(sb: SupabaseClient, days: string[], base: string): Promise<BoardSales> {
  const rows = await runQ<{ d: string; channel: string; rev: number; orders: number }>(sb,
    `select order_date::text as d, channel, coalesce(sum(subtotal_amount),0)::bigint as rev, count(distinct ${ORDER_UNIT_SQL})::int as orders from sales_orders where order_date between '${days[0]}' and '${base}' group by 1, 2`);
  const idx = new Map(days.map((x, i) => [x, i]));
  const byCh = new Map<string, { rev: number[]; orders: number[] }>();
  for (const r of rows) {
    const i = idx.get(String(r.d)); if (i == null) continue;
    const name = String(r.channel || "").trim() || "기타";
    if (!byCh.has(name)) byCh.set(name, { rev: zeros(days.length), orders: zeros(days.length) });
    const c = byCh.get(name)!;
    c.rev[i] += num(r.rev); c.orders[i] += num(r.orders);
  }
  const channels = [...byCh.entries()].map(([name, c]) => ({ name, ...c, total: c.rev.reduce((s, x) => s + x, 0) }))
    .filter((c) => c.total !== 0 || c.orders.some((o) => o > 0)).sort((a, b) => b.total - a.total).map(({ name, rev, orders }) => ({ name, rev, orders }));
  return { ok: true, channels };
}

// ── 메타 광고 ── 계정 합계를 하루 한 행으로(90일씩 나눠 요청). 그 조회가 거절되면 종합 리포트가 쓰는 캠페인별 일별 인사이트를 날짜로 더한다.
async function metaSection(days: string[]): Promise<BoardMeta> {
  const parts: { since: string; until: string }[] = [];
  for (let i = 0; i < days.length; i += 90) parts.push({ since: days[i], until: days[Math.min(i + 89, days.length - 1)] });
  type Row = { date: string; spend: number; purchaseValue: number; purchases: number; impressions: number; clicks: number };
  const rows: Row[] = await timeout(Promise.all(parts.map((p) => getAccountDaily(p))).then((xs) => xs.flat()), 25_000, "메타 광고")
    .catch(async () => Object.values(await timeout(getInsightSeries({ since: days[0], until: days[days.length - 1] }, 1), 35_000, "메타 광고")).flat()
      .map((r) => ({ date: r.date, spend: r.spend, purchaseValue: r.purchaseValue, purchases: r.purchases, impressions: r.impressions, clicks: r.linkClicks || 0 })));
  const idx = new Map(days.map((x, i) => [x, i]));
  const spend = zeros(days.length), value = zeros(days.length), purchases = zeros(days.length), impressions = zeros(days.length), clicks = zeros(days.length);
  for (const r of rows) {
    const i = idx.get(r.date); if (i == null) continue;
    spend[i] += num(r.spend); value[i] += num(r.purchaseValue); purchases[i] += num(r.purchases); impressions[i] += num(r.impressions); clicks[i] += num(r.clicks);
  }
  return { ok: true, spend: spend.map(Math.round), value: value.map(Math.round), purchases, impressions, clicks };
}

// ── 네이버 검색광고 ── 광고비·노출·클릭은 하루씩(캠페인 합계), 구매 전환은 일별 캐시(naver_conv_daily)에서.
//  지난 묶음에 있는 날은 그대로 쓰고(최근 3일 제외), 없는 날만 최근부터 6일씩 병렬로 받는다. 시간 안에 못 받은 날은 null 로 남는다.
//  구매 전환 캐시는 종합 리포트가 날마다 채운다. 여기서는 최근 7일만 다시 확인한다(어제분은 늦게 잡혀 매번 새로 받는다).
async function naverSection(sb: SupabaseClient, days: string[], base: string, prev: BoardSnapshot | null): Promise<BoardNaver> {
  const n = days.length;
  const cost: Nullable = new Array(n).fill(null), impressions: Nullable = new Array(n).fill(null), clicks: Nullable = new Array(n).fill(null);
  const old = prev?.naver?.ok ? prev.naver : null;
  if (old && prev) {
    const at = new Map(prev.days.map((d, i) => [d, i]));
    const keepUntil = shift(base, -NAVER_REFRESH_DAYS);
    days.forEach((d, i) => { const k = at.get(d); if (k != null && d <= keepUntil && old.cost[k] != null) { cost[i] = old.cost[k]; impressions[i] = old.impressions[k]; clicks[i] = old.clicks[k]; } });
  }
  const ids = (await listCampaigns()).map((c) => c.nccCampaignId);
  const todo = days.map((_, i) => i).filter((i) => cost[i] == null).reverse(); // 최근부터
  const deadline = Date.now() + NAVER_BUDGET_MS;
  const costP = (async () => {
    if (!ids.length) { todo.forEach((i) => { cost[i] = 0; impressions[i] = 0; clicks[i] = 0; }); return; }
    for (let k = 0; k < todo.length && Date.now() < deadline; k += 6) {
      await Promise.all(todo.slice(k, k + 6).map(async (i) => {
        const rows = await getStats(ids, { since: days[i], until: days[i] });
        cost[i] = Math.round(rows.reduce((s, r) => s + num(r.salesAmt), 0));
        impressions[i] = rows.reduce((s, r) => s + num(r.impCnt), 0);
        clicks[i] = rows.reduce((s, r) => s + num(r.clkCnt), 0);
      }));
    }
  })();
  const convP = timeout(getPurchaseConversions(shift(base, -6), base, "adgroup"), 45_000, "네이버 구매 전환")
    .then((r) => !r.failedDays.length && r.cached, () => false);
  const [, purchaseOk] = await Promise.all([costP, convP]);

  const purchaseSales = zeros(n), purchases = zeros(n);
  let tableOk = true;
  try {
    const rows = await fetchAllPages<{ stat_date: string; purchase_conv: number; purchase_sales: number }>((lo, hi) => sb.from("naver_conv_daily")
      .select("stat_date, entity_id, purchase_conv, purchase_sales").eq("entity_type", "adgroup").gte("stat_date", days[0]).lte("stat_date", base)
      .order("stat_date", { ascending: true }).order("entity_id", { ascending: true }).range(lo, hi), { cap: 50000, label: "네이버 구매 전환" });
    const idx = new Map(days.map((x, i) => [x, i]));
    for (const r of rows) { const i = idx.get(String(r.stat_date)); if (i == null) continue; purchases[i] += num(r.purchase_conv); purchaseSales[i] += num(r.purchase_sales); }
  } catch { tableOk = false; }
  return { ok: true, cost, impressions, clicks, purchaseSales, purchases, purchaseOk: purchaseOk && tableOk };
}

// ── GA4 ── 본 속성(쇼핑몰)만. 날짜 × 채널 그룹 한 번 — 방문이 많은 9곳 + 기타.
async function gaSection(days: string[], base: string): Promise<BoardGa> {
  const res = await timeout(runGaReport({ since: days[0], until: base, dimensions: ["date", "channel"], metrics: ["sessions", "purchases"], limit: 5000 }), 45_000, "GA4");
  const [cDate, cName, cSes, cPur] = res.columns;
  const idx = new Map(days.map((x, i) => [x, i]));
  const by = new Map<string, { sessions: number[]; purchases: number[] }>();
  for (const r of res.rows) {
    const i = idx.get(String(r[cDate])); if (i == null) continue;
    const name = String(r[cName] || "").trim() || "(없음)";
    if (!by.has(name)) by.set(name, { sessions: zeros(days.length), purchases: zeros(days.length) });
    const c = by.get(name)!;
    c.sessions[i] += num(r[cSes]); c.purchases[i] += num(r[cPur]);
  }
  const ranked = [...by.entries()].map(([name, c]) => ({ name, ...c, total: c.sessions.reduce((s, x) => s + x, 0) })).sort((a, b) => b.total - a.total);
  const top = ranked.slice(0, GA_TOP_CHANNELS), rest = ranked.slice(GA_TOP_CHANNELS);
  const channels = top.map(({ name, sessions, purchases }) => ({ name, sessions, purchases }));
  if (rest.length) channels.push({ name: "기타", sessions: days.map((_, i) => rest.reduce((s, c) => s + c.sessions[i], 0)), purchases: days.map((_, i) => rest.reduce((s, c) => s + c.purchases[i], 0)) });
  return { ok: true, channels, truncated: res.truncated };
}

// ── 정기배송 ── 회원 수는 날마다의 자동 스냅샷, 신규·해지는 상태 변화 로그(신청 단위·관측일), 매출은 결제 주문번호로 매출 원장과 이음.
async function subSection(sb: SupabaseClient, days: string[], base: string): Promise<BoardSub> {
  const [snap, log, rev] = await Promise.all([
    sb.from("subscription_snapshots").select("data_date, snapshot").gte("data_date", days[0]).lte("data_date", base).order("data_date", { ascending: true }),
    runQ<{ d: string; kind: string; n: number }>(sb, `select changed_on::text as d, case when prev_state is null then 'new' when new_state = 'C' then 'cancel' else 'other' end as kind, count(*)::int as n from cafe24_subscription_state_log where changed_on between '${days[0]}' and '${base}' group by 1, 2`),
    runQ<{ d: string; rev: number }>(sb, `select order_date::text as d, coalesce(sum(subtotal_amount),0)::bigint as rev from sales_orders where order_date between '${days[0]}' and '${base}' and order_id in (select order_id from cafe24_subscription_payments) group by 1`),
  ]);
  if (snap.error) throw new Error(`subscription_snapshots: ${snap.error.message}`);
  const idx = new Map(days.map((x, i) => [x, i]));
  const active: Nullable = new Array(days.length).fill(null), pause: Nullable = new Array(days.length).fill(null);
  let asOf = "";
  for (const r of (snap.data || []) as { data_date: string; snapshot: Record<string, unknown> | null }[]) {
    const i = idx.get(String(r.data_date)); if (i == null || !r.snapshot) continue;
    active[i] = num(r.snapshot.activeMembers); pause[i] = num(r.snapshot.pauseMembers); asOf = String(r.data_date);
  }
  if (!asOf) throw new Error("정기배송 스냅샷이 없습니다. 정기배송 분석의 자동 수집을 확인하세요.");
  const newCnt = zeros(days.length), cancelCnt = zeros(days.length), subRev = zeros(days.length);
  for (const r of log) { const i = idx.get(String(r.d)); if (i == null) continue; if (r.kind === "new") newCnt[i] += num(r.n); else if (r.kind === "cancel") cancelCnt[i] += num(r.n); }
  for (const r of rev) { const i = idx.get(String(r.d)); if (i != null) subRev[i] = num(r.rev); }
  return { ok: true, asOf, active, pause, newCnt, cancelCnt, subRev };
}

// ── VOC ── 접수일 기준, 설문 제외(종합 리포트 고객의 소리와 같은 조건).
async function vocSection(sb: SupabaseClient, days: string[], base: string): Promise<BoardVoc> {
  const rows = await fetchAllPages<{ received_at: string }>((lo, hi) => sb.from("voc").select("id, received_at")
    .gte("received_at", days[0]).lte("received_at", base).neq("source", "설문")
    .order("received_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi), { cap: 50000, label: "VOC" });
  const idx = new Map(days.map((x, i) => [x, i]));
  const counts = zeros(days.length);
  for (const r of rows) { const i = idx.get(String(r.received_at).slice(0, 10)); if (i != null) counts[i]++; }
  return { ok: true, counts };
}

export async function buildBoard(sb: SupabaseClient, prev: BoardSnapshot | null = null): Promise<BoardSnapshot> {
  const { fp, base } = await salesFingerprint(sb);
  const days = Array.from({ length: BOARD_DAYS }, (_, i) => shift(base, i - (BOARD_DAYS - 1)));
  const [sales, meta, naver, ga, sub, voc] = await Promise.all([
    salesSection(sb, days, base).catch(fail),
    isMetaAdConfigured() ? metaSection(days).catch(fail) : Promise.resolve(null),
    isNaverAdConfigured() ? naverSection(sb, days, base, prev).catch(fail) : Promise.resolve(null),
    isGaConfigured() ? gaSection(days, base).catch(fail) : Promise.resolve(null),
    subSection(sb, days, base).catch(fail),
    vocSection(sb, days, base).catch(fail),
  ]);
  return { v: BOARD_VERSION, base, builtAt: new Date().toISOString(), builtDay: kstToday(), salesFp: fp, days, sales, meta, naver, ga, sub, voc };
}

// ── 기간 상세 ── 날마다 더할 수 없는 값(고유 고객 수)과 상품별 표. 화면이 기간·채널을 바꿀 때마다 부른다(Supabase 만 읽는다).
export async function boardDetail(sb: SupabaseClient, from: string, to: string, channels: string[]): Promise<BoardDetail> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new Error("기간이 올바르지 않습니다.");
  const n = daysBetween(from, to);
  if (n > 366) throw new Error("기간은 1년 이하로 고르세요.");
  const prevFrom = shift(from, -n), prevTo = shift(from, -1);
  const chs = [...new Set(channels.map((c) => c.trim()).filter((c) => CHANNEL_RE.test(c)))].slice(0, 30);
  const chSql = chs.length ? ` and o.channel in (${chs.map((c) => `'${c}'`).join(",")})` : "";
  const cust = async (f: string, t: string): Promise<NewRepeat> => {
    const { data, error } = await sb.rpc("sales_new_repeat", { p_from: f, p_to: t });
    if (error) throw new Error(`sales_new_repeat: ${error.message}`);
    const r = (data || [])[0] as { total?: unknown; new_cust?: unknown; repeat_cust?: unknown } | undefined;
    return { total: num(r?.total), newCust: num(r?.new_cust), repeatCust: num(r?.repeat_cust) };
  };
  // 상품명 = 상품 마스터(products.name + spec) 우선, 없으면 매출 원장에서 가장 많이 쓰인 이름(매출 리포트 Top 10 과 같은 식)
  const [rows, cur, prev] = await Promise.all([
    runQ<{ code: string; name: string; rev: number; qty: number; orders: number; prev_rev: number }>(sb,
      `select o.sku_code as code, coalesce(max(p.name) || coalesce(' ' || max(p.spec), ''), mode() within group (order by o.product_name)) as name, `
      + `coalesce(sum(o.subtotal_amount) filter (where o.order_date >= '${from}'),0)::bigint as rev, coalesce(sum(o.quantity) filter (where o.order_date >= '${from}'),0)::int as qty, `
      + `(count(distinct o.order_unit) filter (where o.order_date >= '${from}'))::int as orders, coalesce(sum(o.subtotal_amount) filter (where o.order_date < '${from}'),0)::bigint as prev_rev `
      + `from sales_orders o left join products p on upper(p.sku) = upper(o.sku_code) where o.order_date between '${prevFrom}' and '${to}' and o.sku_code <> ''${chSql} group by o.sku_code order by rev desc limit 30`),
    cust(from, to).catch(() => null), cust(prevFrom, prevTo).catch(() => null),
  ]);
  const products: BoardProduct[] = rows.filter((r) => num(r.rev) > 0).map((r) => ({ code: String(r.code), name: String(r.name || r.code), rev: num(r.rev), qty: num(r.qty), orders: num(r.orders), prevRev: num(r.prev_rev) }));
  return { from, to, products, cust: cur && prev ? { cur, prev } : null };
}

// ── 저장·읽기 ──
export async function readBoard(): Promise<BoardSnapshot | null> {
  const r = await readKvSoft<BoardSnapshot>(KV_SNAPSHOT);
  return r.value && r.value.v === BOARD_VERSION && Array.isArray(r.value.days) ? r.value : null;
}

const naverPending = (s: BoardSnapshot) => !!s.naver?.ok && s.naver.cost.some((v) => v == null);

/** 저장된 묶음이 낡았는가 — 날이 바뀌었거나, (계산한 지 10분이 지났고) 매출이 새로 들어왔거나 네이버 광고비를 덜 받았다. */
export async function isStale(sb: SupabaseClient, snap: BoardSnapshot): Promise<boolean> {
  if (snap.builtDay !== kstToday()) return true;
  if (Date.now() - Date.parse(snap.builtAt) < AUTO_GAP_MS) return false;
  if (naverPending(snap)) return true;
  try { return (await salesFingerprint(sb)).fp !== snap.salesFp; } catch { return false; }
}

/** 계산하고 저장한다. 다른 실행이 계산 중이면 BoardBusy. manual = [다시 계산](1분 안 연타는 BoardBusy). */
export async function rebuildBoard(opts: { manual?: boolean } = {}): Promise<BoardSnapshot> {
  const sb = supabaseAdmin();
  const now = Date.now();
  const prev = await readBoard();
  if (opts.manual && prev && now - Date.parse(prev.builtAt) < MANUAL_GAP_MS) throw new BoardBusy("방금 계산했습니다. 1분 뒤에 다시 누르세요.");
  // 계산 자리 잡기 — 읽은 값이 그대로일 때만 쓰이므로(낙관적 잠금) 두 실행이 동시에 잡지 못한다
  await mutateKv<{ at: string }>(KV_BUILD, (cur) => {
    if (cur?.at && now - Date.parse(cur.at) < LOCK_MS) throw new BoardBusy("지금 계산하고 있습니다. 잠시 뒤 다시 불러오세요.");
    return { at: new Date(now).toISOString() };
  });
  try {
    const snap = await buildBoard(sb, prev);
    await mutateKv<BoardSnapshot>(KV_SNAPSHOT, () => snap);
    return snap;
  } finally {
    await mutateKv<{ at: string }>(KV_BUILD, () => ({ at: "" })).catch(() => {});
  }
}
