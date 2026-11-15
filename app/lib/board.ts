// 주요 지표(/board, 2026-11-15) — 매출·주문 / 광고·유입 / 정기배송·고객을 한 묶음으로 모아 b2b_settings 에 저장한다. 서버 전용.
//  · 하루 한 번: 그날 처음 화면을 열 때 계산한다(예약 신호·크론 없음). 그 뒤에는 저장된 묶음을 그대로 준다.
//  · 매출이 새로 들어오면(지문이 달라지면) 다시 계산한다 — 아침에 연 묶음이 매출 업로드 전 숫자로 하루 종일 남지 않게.
//  · 기준일 = 매출이 들어온 마지막 날(어제까지). 모든 구역이 같은 기준일·같은 56일을 쓴다.
//  · 구역 하나가 실패해도 나머지는 나간다(구역마다 ok/error). 외부 조회(메타·네이버·GA)에는 시간 상한을 둔다.
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
import { BOARD_DAYS, BOARD_WINDOWS, type BoardSnapshot, type BoardSales, type BoardMeta, type BoardNaver, type BoardGa, type BoardSub, type BoardVoc, type Fail, type NewRepeat, type BoardWindow } from "./board-types";

const KV_SNAPSHOT = "board_snapshot";
const KV_BUILD = "board_build";
const LOCK_MS = 3 * 60_000;        // 계산 중 표시가 이보다 오래되면 죽은 실행으로 본다
const AUTO_GAP_MS = 10 * 60_000;   // 매출 지문이 달라져도 이 간격 안에는 다시 계산하지 않는다
const MANUAL_GAP_MS = 60_000;      // [다시 계산] 연타 방지

export class BoardBusy extends Error { constructor(msg: string) { super(msg); this.name = "BoardBusy"; } }

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const shift = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const num = (v: unknown) => Number(v) || 0;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message?: unknown }).message) : String(e));
const fail = (e: unknown): Fail => ({ ok: false, error: errMsg(e).slice(0, 200) });
const timeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 조회 시간 초과(${Math.round(ms / 1000)}초)`)), ms))]);

async function runQ<T>(sb: SupabaseClient, q: string): Promise<T[]> {
  const { data, error } = await sb.rpc("run_report", { q, p_limit: 5000 });
  if (error) throw new Error(`집계 실패: ${error.message}`);
  return (Array.isArray(data) ? data : []) as T[];
}

// ── 매출 지문·기준일 ── 최근 10일의 마지막 주문일과 줄 수. 오늘 주문이 들어와 있어도 기준일은 어제까지.
export async function salesFingerprint(sb: SupabaseClient): Promise<{ fp: string; base: string }> {
  const today = kstToday(), yesterday = shift(today, -1);
  const r = await runQ<{ mx: string | null; n: number }>(sb, `select max(order_date)::text as mx, count(*)::int as n from sales_orders where order_date between '${shift(today, -10)}' and '${today}'`);
  const mx = r[0]?.mx ? String(r[0].mx) : "";
  return { fp: `${mx}:${num(r[0]?.n)}`, base: mx && mx < yesterday ? mx : yesterday };
}

// ── 매출·주문 ──
async function salesSection(sb: SupabaseClient, days: string[], base: string): Promise<BoardSales> {
  // 이번 달 누적과 전월 같은 기간 — 56일 창보다 앞설 수 있어(31일) 조회 시작을 전월 1일까지 당긴다
  const [y, m, d] = base.split("-").map(Number);
  const mFrom = `${base.slice(0, 8)}01`;
  const prevLast = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();   // 전월 말일
  const pm = new Date(Date.UTC(y, m - 2, 1));
  const pmYm = `${pm.getUTCFullYear()}-${String(pm.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevFrom = `${pmYm}-01`, prevTo = `${pmYm}-${String(Math.min(d, prevLast)).padStart(2, "0")}`;
  const from = prevFrom < days[0] ? prevFrom : days[0];

  const custRange = (n: number, skip: number) => ({ p_from: shift(base, -(skip + n - 1)), p_to: shift(base, -skip) });
  const cust = async (n: number, skip: number): Promise<NewRepeat> => {
    const { data, error } = await sb.rpc("sales_new_repeat", custRange(n, skip));
    if (error) throw new Error(`sales_new_repeat: ${error.message}`);
    const r = (data || [])[0] as { total?: unknown; new_cust?: unknown; repeat_cust?: unknown } | undefined;
    return { total: num(r?.total), newCust: num(r?.new_cust), repeatCust: num(r?.repeat_cust) };
  };
  const [rows, ...custs] = await Promise.all([
    runQ<{ d: string; channel: string; rev: number; orders: number }>(sb,
      `select order_date::text as d, channel, coalesce(sum(subtotal_amount),0)::bigint as rev, count(distinct ${ORDER_UNIT_SQL})::int as orders from sales_orders where order_date between '${from}' and '${base}' group by 1, 2`),
    ...BOARD_WINDOWS.flatMap((w) => [cust(w, 0).catch(() => null), cust(w, w).catch(() => null)]),
  ]);

  const idx = new Map(days.map((x, i) => [x, i]));
  const zeros = () => new Array<number>(days.length).fill(0);
  const rev = zeros(), orders = zeros();
  const byCh = new Map<string, number[]>();
  const mtd = { from: mFrom, to: base, rev: 0, orders: 0, prevFrom, prevTo, prevRev: 0, prevOrders: 0 };
  for (const r of rows) {
    const day = String(r.d), i = idx.get(day), v = num(r.rev), o = num(r.orders);
    if (i != null) {
      rev[i] += v; orders[i] += o;
      const name = String(r.channel || "").trim() || "기타";
      if (!byCh.has(name)) byCh.set(name, zeros());
      byCh.get(name)![i] += v;
    }
    if (day >= mFrom && day <= base) { mtd.rev += v; mtd.orders += o; }
    if (day >= prevFrom && day <= prevTo) { mtd.prevRev += v; mtd.prevOrders += o; }
  }
  const channels = [...byCh.entries()].map(([name, xs]) => ({ name, rev: xs, total: xs.reduce((s, x) => s + x, 0) }))
    .filter((c) => c.total !== 0).sort((a, b) => b.total - a.total).map(({ name, rev: xs }) => ({ name, rev: xs }));
  const custOut = {} as BoardSales["cust"];
  BOARD_WINDOWS.forEach((w, k) => { const cur = custs[k * 2], prev = custs[k * 2 + 1]; custOut[w] = cur && prev ? { cur, prev } : null; });
  return { ok: true, rev, orders, channels, mtd, cust: custOut };
}

// ── 메타 광고 ── 계정 합계를 하루 한 행으로(요청 한 번). 그 조회가 거절되면 종합 리포트가 쓰는 캠페인별 일별 인사이트를 날짜로 더한다.
async function metaSection(days: string[]): Promise<BoardMeta> {
  const range = { since: days[0], until: days[days.length - 1] };
  const rows = await timeout(getAccountDaily(range), 20_000, "메타 광고")
    .catch(async () => Object.values(await timeout(getInsightSeries(range, 1), 40_000, "메타 광고")).flat());
  const idx = new Map(days.map((x, i) => [x, i]));
  const spend = new Array<number>(days.length).fill(0), value = new Array<number>(days.length).fill(0), purchases = new Array<number>(days.length).fill(0);
  for (const r of rows) {
    const i = idx.get(r.date); if (i == null) continue;
    spend[i] += num(r.spend); value[i] += num(r.purchaseValue); purchases[i] += num(r.purchases);
  }
  return { ok: true, spend: spend.map(Math.round), value: value.map(Math.round), purchases };
}

// ── 네이버 검색광고 ── 광고비는 하루씩(캠페인 합계, 4일씩 병렬), 구매 전환은 일별 캐시(naver_conv_daily)에서.
//  구매 전환 캐시는 종합 리포트가 날마다 채운다. 여기서는 최근 7일만 다시 확인한다(어제분은 늦게 잡혀 매번 새로 받는다).
async function naverSection(sb: SupabaseClient, days: string[], base: string): Promise<BoardNaver> {
  const ids = (await listCampaigns()).map((c) => c.nccCampaignId);
  const cost = new Array<number>(days.length).fill(0);
  const costP = (async () => {
    for (let i = 0; i < days.length && ids.length; i += 4) {
      await Promise.all(days.slice(i, i + 4).map(async (day, k) => {
        const rows = await getStats(ids, { since: day, until: day });
        cost[i + k] = Math.round(rows.reduce((s, r) => s + num(r.salesAmt), 0));
      }));
    }
  })();
  const convP = timeout(getPurchaseConversions(shift(base, -6), base, "adgroup"), 45_000, "네이버 구매 전환")
    .then((r) => !r.failedDays.length && r.cached, () => false);
  const [, purchaseOk] = await Promise.all([timeout(costP, 60_000, "네이버 광고비"), convP]);

  const purchaseSales = new Array<number>(days.length).fill(0), purchases = new Array<number>(days.length).fill(0);
  let tableOk = true;
  try {
    const rows = await fetchAllPages<{ stat_date: string; purchase_conv: number; purchase_sales: number }>((lo, hi) => sb.from("naver_conv_daily")
      .select("stat_date, entity_id, purchase_conv, purchase_sales").eq("entity_type", "adgroup").gte("stat_date", days[0]).lte("stat_date", base)
      .order("stat_date", { ascending: true }).order("entity_id", { ascending: true }).range(lo, hi), { cap: 20000, label: "네이버 구매 전환" });
    const idx = new Map(days.map((x, i) => [x, i]));
    for (const r of rows) { const i = idx.get(String(r.stat_date)); if (i == null) continue; purchases[i] += num(r.purchase_conv); purchaseSales[i] += num(r.purchase_sales); }
  } catch { tableOk = false; }
  return { ok: true, cost, purchaseSales, purchases, purchaseOk: purchaseOk && tableOk };
}

// ── GA4 ── 본 속성(쇼핑몰)만. 날짜별 한 번 + 기간별 채널 그룹.
async function gaSection(days: string[], base: string): Promise<BoardGa> {
  const daily = runGaReport({ since: days[0], until: base, dimensions: ["date"], metrics: ["sessions", "users", "purchases"], limit: 200 });
  const chan = (w: BoardWindow) => runGaReport({ since: shift(base, -(w - 1)), until: base, dimensions: ["channel"], metrics: ["sessions", "purchases"], limit: 12 });
  const [dr, ...cr] = await timeout(Promise.all([daily, ...BOARD_WINDOWS.map(chan)]), 45_000, "GA4");
  const idx = new Map(days.map((x, i) => [x, i]));
  const sessions = new Array<number>(days.length).fill(0), users = new Array<number>(days.length).fill(0), purchases = new Array<number>(days.length).fill(0);
  const [cDate, cSes, cUsr, cPur] = dr.columns;
  for (const r of dr.rows) {
    const i = idx.get(String(r[cDate])); if (i == null) continue;
    sessions[i] = num(r[cSes]); users[i] = num(r[cUsr]); purchases[i] = num(r[cPur]);
  }
  const channels = {} as BoardGa["channels"];
  BOARD_WINDOWS.forEach((w, k) => {
    const [cName, cS, cP] = cr[k].columns;
    channels[w] = cr[k].rows.map((r) => ({ name: String(r[cName] || "(없음)"), sessions: num(r[cS]), purchases: num(r[cP]) })).filter((c) => c.sessions > 0);
  });
  return { ok: true, sessions, users, purchases, channels };
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
  const active = new Array<number | null>(days.length).fill(null), pause = new Array<number | null>(days.length).fill(null);
  let asOf = "";
  for (const r of (snap.data || []) as { data_date: string; snapshot: Record<string, unknown> | null }[]) {
    const i = idx.get(String(r.data_date)); if (i == null || !r.snapshot) continue;
    active[i] = num(r.snapshot.activeMembers); pause[i] = num(r.snapshot.pauseMembers); asOf = String(r.data_date);
  }
  if (!asOf) throw new Error("정기배송 스냅샷이 없습니다. 정기배송 분석의 자동 수집을 확인하세요.");
  const newCnt = new Array<number>(days.length).fill(0), cancelCnt = new Array<number>(days.length).fill(0), subRev = new Array<number>(days.length).fill(0);
  for (const r of log) { const i = idx.get(String(r.d)); if (i == null) continue; if (r.kind === "new") newCnt[i] += num(r.n); else if (r.kind === "cancel") cancelCnt[i] += num(r.n); }
  for (const r of rev) { const i = idx.get(String(r.d)); if (i != null) subRev[i] = num(r.rev); }
  return { ok: true, asOf, active, pause, newCnt, cancelCnt, subRev };
}

// ── VOC ── 접수일 기준, 설문 제외(종합 리포트 고객의 소리와 같은 조건).
async function vocSection(sb: SupabaseClient, days: string[], base: string): Promise<BoardVoc> {
  const rows = await fetchAllPages<{ received_at: string }>((lo, hi) => sb.from("voc").select("id, received_at")
    .gte("received_at", days[0]).lte("received_at", base).neq("source", "설문")
    .order("received_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi), { cap: 20000, label: "VOC" });
  const idx = new Map(days.map((x, i) => [x, i]));
  const counts = new Array<number>(days.length).fill(0);
  for (const r of rows) { const i = idx.get(String(r.received_at).slice(0, 10)); if (i != null) counts[i]++; }
  return { ok: true, counts };
}

export async function buildBoard(sb: SupabaseClient): Promise<BoardSnapshot> {
  const { fp, base } = await salesFingerprint(sb);
  const days = Array.from({ length: BOARD_DAYS }, (_, i) => shift(base, i - (BOARD_DAYS - 1)));
  const [sales, meta, naver, ga, sub, voc] = await Promise.all([
    salesSection(sb, days, base).catch(fail),
    isMetaAdConfigured() ? metaSection(days).catch(fail) : Promise.resolve(null),
    isNaverAdConfigured() ? naverSection(sb, days, base).catch(fail) : Promise.resolve(null),
    isGaConfigured() ? gaSection(days, base).catch(fail) : Promise.resolve(null),
    subSection(sb, days, base).catch(fail),
    vocSection(sb, days, base).catch(fail),
  ]);
  return { v: 1, base, builtAt: new Date().toISOString(), builtDay: kstToday(), salesFp: fp, days, sales, meta, naver, ga, sub, voc };
}

// ── 저장·읽기 ──
export async function readBoard(): Promise<BoardSnapshot | null> {
  const r = await readKvSoft<BoardSnapshot>(KV_SNAPSHOT);
  return r.value && r.value.v === 1 && Array.isArray(r.value.days) ? r.value : null;
}

/** 저장된 묶음이 낡았는가 — 날이 바뀌었거나, 매출이 새로 들어왔다(계산한 지 10분이 지났을 때만). */
export async function isStale(sb: SupabaseClient, snap: BoardSnapshot): Promise<boolean> {
  if (snap.builtDay !== kstToday()) return true;
  if (Date.now() - Date.parse(snap.builtAt) < AUTO_GAP_MS) return false;
  try { return (await salesFingerprint(sb)).fp !== snap.salesFp; } catch { return false; }
}

/** 계산하고 저장한다. 다른 실행이 계산 중이면 BoardBusy. manual = [다시 계산](1분 안 연타는 BoardBusy). */
export async function rebuildBoard(opts: { manual?: boolean } = {}): Promise<BoardSnapshot> {
  const sb = supabaseAdmin();
  const now = Date.now();
  if (opts.manual) {
    const cur = await readBoard();
    if (cur && now - Date.parse(cur.builtAt) < MANUAL_GAP_MS) throw new BoardBusy("방금 계산했습니다. 1분 뒤에 다시 누르세요.");
  }
  // 계산 자리 잡기 — 읽은 값이 그대로일 때만 쓰이므로(낙관적 잠금) 두 실행이 동시에 잡지 못한다
  await mutateKv<{ at: string }>(KV_BUILD, (cur) => {
    if (cur?.at && now - Date.parse(cur.at) < LOCK_MS) throw new BoardBusy("지금 계산하고 있습니다. 잠시 뒤 다시 불러오세요.");
    return { at: new Date(now).toISOString() };
  });
  try {
    const snap = await buildBoard(sb);
    await mutateKv<BoardSnapshot>(KV_SNAPSHOT, () => snap);
    return snap;
  } finally {
    await mutateKv<{ at: string }>(KV_BUILD, () => ({ at: "" })).catch(() => {});
  }
}
