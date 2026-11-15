// 주요 지표 주제 보고서(2026-11-16) — 주제 하나(예: 체험단)의 구매·광고 효율·페이지 전환·재구매를 모은다. 서버 전용.
//  대표가 이 화면으로 알고 싶은 것: ① 체험단 구매가 얼마나 생기는가 ② 구매를 유도하는 광고의 효율 ③ 체험단 페이지의 전환율과 병목 ④ 체험 이후 재구매(만족).
//  · 주제 정의는 board-types.ts 의 TOPICS(대표와 같이 정한 정확한 대상). 화면에서 만들거나 고치지 않는다.
//  · 계산한 묶음은 주제마다 b2b_settings kv `board_topic_<id>`. 본 묶음과 같은 기준일·같은 180일. 화면이 기간을 잘라 쓴다.
//  · 하루 한 번: 그날 처음 그 주제를 열 때 계산한다(정의나 기준일이 달라져도 다시 계산). 크론·마이그레이션 없음.
//  · 고객은 '그 상품을 처음 산 날'로 센다 — 한 고객이 하루에만 들어가 기간으로 더해도 겹치지 않는다.
//    신규 = 씨몬스터 첫 주문이 그날, 재구매 = 다음 날부터 주제 밖의 상품을 산 고객(30일 안 / 기준일까지).
//  · 페이지 단계의 단위가 다르다: 방문·스크롤 = GA4 세션, 주문서 진입 = GA4 상품 결제 시작 수량, 구매 = 매출 원장의 주문 건수.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { readKvSoft, mutateKv } from "./production-kv";
import { isMetaAdConfigured, getDailyByName } from "./meta-ad";
import { isGaConfigured, runGaReport, type GaFilter } from "./ga";
import { readBoard, salesFingerprint } from "./board";
import { BOARD_DAYS, TOPIC_VERSION, TOPICS, TOPIC_REPEAT_DAYS, shiftDay as shift, type TopicDef, type TopicSnapshot, type TopicSales, type TopicCust, type TopicGa, type TopicMeta, type Fail } from "./board-types";

const kvData = (id: string) => `board_topic_${id}`;
const MANUAL_GAP_MS = 60_000;
const ITEM_LIMIT = 20_000;      // 날짜 × 채널 × 상품 줄 수 상한(넘으면 정의가 너무 넓다)
const TOP_ITEMS = 30, TOP_AFTER = 15, TOP_SOURCES = 12, TOP_ADS = 40;

export class TopicError extends Error { constructor(msg: string, public status = 400) { super(msg); this.name = "TopicError"; } }

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v) || 0;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message?: unknown }).message) : String(e));
const fail = (e: unknown): Fail => ({ ok: false, error: errMsg(e).slice(0, 200) });
const timeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 조회 시간 초과(${Math.round(ms / 1000)}초)`)), ms))]);
const zeros = (n: number) => new Array<number>(n).fill(0);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const likeLit = (s: string) => lit(`%${s.replace(/[\\%_]/g, "\\$&")}%`);   // 포함 검색(와일드카드 무력화)

async function runQ<T>(sb: SupabaseClient, q: string, limit = 5000): Promise<T[]> {
  const { data, error } = await sb.rpc("run_report", { q, p_limit: limit });
  if (error) throw new Error(`집계 실패: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as T[];
  if (rows.length >= limit) throw new Error("집계 결과가 너무 많아 잘렸습니다."); // 잘린 결과로 합계를 내지 않는다
  return rows;
}

// 주제 상품 = 주문 상품명에 정의한 구절이 든 주문 줄
const prodSql = (def: TopicDef) => def.productLike.map((k) => `o.product_name ilike ${likeLit(k)}`).join(" or ");

// ── 매출 ──
async function salesSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicSales> {
  const where = `o.order_date between '${days[0]}' and '${base}' and (${prodSql(def)})`;
  const sums = `coalesce(sum(o.subtotal_amount),0)::bigint as rev, count(distinct o.order_unit)::int as orders, coalesce(sum(o.quantity),0)::int as qty`;
  type R = { d: string; channel: string; rev: number; orders: number; qty: number };
  const [ch, it] = await Promise.all([
    runQ<R>(sb, `select o.order_date::text as d, o.channel, ${sums} from sales_orders o where ${where} group by 1, 2`),
    runQ<R & { item: string }>(sb, `select o.order_date::text as d, o.channel, o.product_name as item, ${sums} from sales_orders o where ${where} group by 1, 2, 3`, ITEM_LIMIT),
  ]);
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  type Cell = { rev: number[]; orders: number[]; qty: number[] };
  const cell = (): Cell => ({ rev: zeros(n), orders: zeros(n), qty: zeros(n) });
  const put = (c: Cell, i: number, r: R) => { c.rev[i] += num(r.rev); c.orders[i] += num(r.orders); c.qty[i] += num(r.qty); };
  const chName = (r: R) => String(r.channel || "").trim() || "기타";

  const byCh = new Map<string, Cell>();
  for (const r of ch) { const i = idx.get(String(r.d)); if (i == null) continue; const k = chName(r); if (!byCh.has(k)) byCh.set(k, cell()); put(byCh.get(k)!, i, r); }
  const channels = [...byCh.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => sum(b.rev) - sum(a.rev));

  const byItem = new Map<string, Cell & { name: string; channel: string }>();
  for (const r of it) {
    const i = idx.get(String(r.d)); if (i == null) continue;
    const name = String(r.item || "").trim() || "(이름 없음)", channel = chName(r), k = `${channel}\u0001${name}`;
    if (!byItem.has(k)) byItem.set(k, { name, channel, ...cell() });
    put(byItem.get(k)!, i, r);
  }
  const ranked = [...byItem.values()].sort((a, b) => sum(b.rev) - sum(a.rev));
  // 나머지는 채널마다 '기타' 한 줄로(채널 필터가 그대로 걸리게)
  const rest = new Map<string, Cell & { name: string; channel: string }>();
  for (const r of ranked.slice(TOP_ITEMS)) {
    if (!rest.has(r.channel)) rest.set(r.channel, { name: "기타", channel: r.channel, ...cell() });
    const c = rest.get(r.channel)!;
    for (let i = 0; i < n; i++) { c.rev[i] += r.rev[i]; c.orders[i] += r.orders[i]; c.qty[i] += r.qty[i]; }
  }
  return { ok: true, channels, items: [...ranked.slice(0, TOP_ITEMS), ...rest.values()] };
}

// ── 고객 ── 처음 산 날 기준(전체 기간에서 첫 구매일을 찾고, 180일 안에 든 고객만 날마다 센다). 그 뒤에 산 상품도 같은 기준일 배열로.
async function custSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicCust> {
  const prod = prodSql(def);
  const first = `select o.customer_key, min(o.order_date) as first_t from sales_orders o where o.customer_key <> '' and o.order_date <= '${base}' and (${prod}) group by 1`;
  const other = `o.order_date > t.first_t and not coalesce((${prod}), false)`;
  const [rows, after] = await Promise.all([
    runQ<{ d: string; n: number; fresh: number; conv: number; conv30: number; conv_rev: number }>(sb,
      `with t as (${first}), `
      + `a as (select t.customer_key, t.first_t, min(o.order_date) as first_any, count(*) filter (where ${other}) as after_n, `
      + `count(*) filter (where ${other} and o.order_date <= t.first_t + ${TOPIC_REPEAT_DAYS}) as after_30, coalesce(sum(o.subtotal_amount) filter (where ${other}), 0) as after_rev `
      + `from t join sales_orders o on o.customer_key = t.customer_key where o.order_date <= '${base}' and t.first_t >= '${days[0]}' group by 1, 2) `
      + `select first_t::text as d, count(*)::int as n, (count(*) filter (where first_any = first_t))::int as fresh, (count(*) filter (where after_n > 0))::int as conv, `
      + `(count(*) filter (where after_30 > 0))::int as conv30, coalesce(sum(after_rev), 0)::bigint as conv_rev from a group by 1`),
    runQ<{ d: string; item: string; n: number; rev: number }>(sb,
      `with t as (${first}) select t.first_t::text as d, o.product_name as item, count(distinct t.customer_key)::int as n, coalesce(sum(o.subtotal_amount), 0)::bigint as rev `
      + `from t join sales_orders o on o.customer_key = t.customer_key where t.first_t >= '${days[0]}' and o.order_date <= '${base}' and ${other} group by 1, 2`, ITEM_LIMIT),
  ]);
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const out: TopicCust = { ok: true, first: zeros(n), fresh: zeros(n), conv: zeros(n), conv30: zeros(n), convRev: zeros(n), after: [] };
  for (const r of rows) { const i = idx.get(String(r.d)); if (i == null) continue; out.first[i] = num(r.n); out.fresh[i] = num(r.fresh); out.conv[i] = num(r.conv); out.conv30[i] = num(r.conv30); out.convRev[i] = num(r.conv_rev); }
  const byItem = new Map<string, { name: string; customers: number[]; rev: number[] }>();
  for (const r of after) {
    const i = idx.get(String(r.d)); if (i == null) continue;
    const name = String(r.item || "").trim() || "(이름 없음)";
    if (!byItem.has(name)) byItem.set(name, { name, customers: zeros(n), rev: zeros(n) });
    const c = byItem.get(name)!; c.customers[i] += num(r.n); c.rev[i] += num(r.rev);
  }
  out.after = [...byItem.values()].sort((a, b) => sum(b.customers) - sum(a.customers) || sum(b.rev) - sum(a.rev)).slice(0, TOP_AFTER);
  return out;
}

// ── 랜딩 페이지(GA4) ── 그 주소에서 일어난 이벤트별 방문(세션), 소스/매체별 방문, 그 상품의 결제 시작 수량.
//  소스/매체는 줄이 많아 60일씩 나눠 받는다(한 번에 5,000줄).
async function gaSection(def: TopicDef, days: string[], base: string): Promise<TopicGa> {
  const land = def.landing!;
  const onPage: GaFilter[] = land.paths.map((p): GaFilter => ({ dimension: "page_path", match: "exact", value: p }));
  const parts: { since: string; until: string }[] = [];
  for (let i = 0; i < days.length; i += 60) parts.push({ since: days[i], until: days[Math.min(i + 59, days.length - 1)] });
  const [ev, items, ...src] = await timeout(Promise.all([
    runGaReport({ since: days[0], until: base, limit: 5000, filterAny: onPage, dimensions: ["date", "event_name"], metrics: ["sessions"] }),
    def.gaItemNames.length
      ? runGaReport({ since: days[0], until: base, limit: 5000, filterAny: def.gaItemNames.map((v): GaFilter => ({ dimension: "item_name", match: "exact", value: v })), dimensions: ["date", "item_name"], metrics: ["items_checked_out"] })
      : Promise.resolve(null),
    ...parts.map((p) => runGaReport({ ...p, limit: 5000, filterAny: onPage, dimensions: ["date", "source_medium"], metrics: ["sessions"] })),
  ]), 50_000, "GA4");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const byEvent = new Map<string, number[]>();
  { const [cD, cE, cS] = ev.columns;
    for (const r of ev.rows) { const i = idx.get(String(r[cD])); if (i == null) continue; const k = String(r[cE] || ""); if (!byEvent.has(k)) byEvent.set(k, zeros(n)); byEvent.get(k)![i] += num(r[cS]); } }
  const checkout = zeros(n);
  if (items) { const [cD, , cC] = items.columns; for (const r of items.rows) { const i = idx.get(String(r[cD])); if (i != null) checkout[i] += num(r[cC]); } }
  const sMap = new Map<string, number[]>();
  for (const res of src) { const [cD, cM, cS] = res.columns;
    for (const r of res.rows) { const i = idx.get(String(r[cD])); if (i == null) continue; const k = String(r[cM] || "") || "(없음)"; if (!sMap.has(k)) sMap.set(k, zeros(n)); sMap.get(k)![i] += num(r[cS]); } }
  const sRank = [...sMap.entries()].map(([name, sessions]) => ({ name, sessions })).sort((a, b) => sum(b.sessions) - sum(a.sessions));
  const sources = sRank.slice(0, TOP_SOURCES), sRest = sRank.slice(TOP_SOURCES);
  if (sRest.length) sources.push({ name: "기타", sessions: days.map((_, i) => sRest.reduce((s, c) => s + c.sessions[i], 0)) });
  return {
    ok: true,
    visits: byEvent.get("page_view") || zeros(n),
    scroll: land.scroll.map(([label, event]) => ({ label, sessions: byEvent.get(event) || zeros(n) })),
    checkout, sources,
    truncated: ev.truncated || !!items?.truncated || src.some((x) => x.truncated),
  };
}

// ── 메타 광고 ── 캠페인 이름에 정의한 말이 든 캠페인의 광고별 일별 성과. 60일씩 나눠 받는다(일별 × 광고는 줄이 많다).
async function metaSection(def: TopicDef, days: string[]): Promise<TopicMeta> {
  const parts: { since: string; until: string }[] = [];
  for (let i = 0; i < days.length; i += 60) parts.push({ since: days[i], until: days[Math.min(i + 59, days.length - 1)] });
  const res = await timeout(Promise.all(parts.map((p) => getDailyByName(p, def.metaCampaignLike, ["campaign.name"]))), 70_000, "메타 광고");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  type Ad = TopicMeta["ads"][number];
  const by = new Map<string, Ad>();
  for (const r of res.flatMap((x) => x.rows)) {
    const i = idx.get(r.date); if (i == null) continue;
    if (!by.has(r.id)) by.set(r.id, { id: r.id, campaign: r.campaign, adset: r.adset, name: r.name, spend: zeros(n), impressions: zeros(n), clicks: zeros(n), purchases: zeros(n), value: zeros(n) });
    const a = by.get(r.id)!;
    a.spend[i] += Math.round(num(r.spend)); a.impressions[i] += num(r.impressions); a.clicks[i] += num(r.clicks); a.purchases[i] += num(r.purchases); a.value[i] += Math.round(num(r.purchaseValue));
  }
  const ranked = [...by.values()].sort((a, b) => sum(b.spend) - sum(a.spend));
  const ads = ranked.slice(0, TOP_ADS), rest = ranked.slice(TOP_ADS);
  if (rest.length) {
    const pick = (k: "spend" | "impressions" | "clicks" | "purchases" | "value") => days.map((_, i) => rest.reduce((s, a) => s + a[k][i], 0));
    ads.push({ id: "rest", campaign: "", adset: "", name: `기타 ${rest.length}개`, spend: pick("spend"), impressions: pick("impressions"), clicks: pick("clicks"), purchases: pick("purchases"), value: pick("value") });
  }
  return { ok: true, ads, campaignOnly: res.some((x) => x.campaignOnly) };
}

export async function buildTopic(sb: SupabaseClient, def: TopicDef, base: string): Promise<TopicSnapshot> {
  const days = Array.from({ length: BOARD_DAYS }, (_, i) => shift(base, i - (BOARD_DAYS - 1)));
  const [sales, cust, ga, meta] = await Promise.all([
    salesSection(sb, def, days, base).catch(fail),
    custSection(sb, def, days, base).catch(fail),
    def.landing && isGaConfigured() ? gaSection(def, days, base).catch(fail) : Promise.resolve(null),
    def.metaCampaignLike.length && isMetaAdConfigured() ? metaSection(def, days).catch(fail) : Promise.resolve(null),
  ]);
  return { v: TOPIC_VERSION, id: def.id, cond: JSON.stringify(def), base, builtAt: new Date().toISOString(), builtDay: kstToday(), days, sales, cust, ga, meta };
}

/** 주제 하나의 묶음 — 저장된 것이 오늘 계산됐고 정의·기준일이 같으면 그대로, 아니면 계산해 저장한다. force = [다시 계산](1분 안 연타 거절). */
export async function topicData(id: string, opts: { force?: boolean } = {}): Promise<TopicSnapshot> {
  const def = TOPICS.find((t) => t.id === id);
  if (!def) throw new TopicError("없는 주제입니다. 화면을 새로 고치세요.", 404);
  const sb = supabaseAdmin();
  const base = (await readBoard())?.base ?? (await salesFingerprint(sb)).base;   // 본 묶음과 같은 기준일
  const old = (await readKvSoft<TopicSnapshot>(kvData(id))).value;
  if (old && old.v === TOPIC_VERSION && Array.isArray(old.days) && old.cond === JSON.stringify(def)) {
    if (opts.force && Date.now() - Date.parse(old.builtAt) < MANUAL_GAP_MS) throw new TopicError("방금 계산했습니다. 1분 뒤에 다시 누르세요.", 409);
    if (!opts.force && old.base === base && old.builtDay === kstToday()) return old;
  }
  const data = await buildTopic(sb, def, base);
  await mutateKv<TopicSnapshot>(kvData(id), () => data);
  return data;
}
