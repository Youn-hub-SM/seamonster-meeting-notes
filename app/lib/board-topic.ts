// 주요 지표 주제 보고서(2026-11-16) — 시기마다 달라지는 관심사(예: 체험단)를 조건 세 가지로 정의해 같은 틀로 본다. 서버 전용.
//  대표: "일정한 주기로 필요한 데이터가 달라. 지금은 체험단 상품을 구매한 고객의 추이 — 그 상품 매출, 상품 페이지 GA, 그 광고의 메타 데이터."
//  · 주제 = 이름 + 조건 셋(상품·페이지·광고 이름에 든 말). 목록은 b2b_settings kv `board_topics`, 계산한 묶음은 주제마다 `board_topic_<id>`.
//  · 묶음은 주요 지표 본 묶음과 같은 기준일·같은 180일. 화면이 기간을 잘라 쓴다(board-types.ts).
//  · 하루 한 번: 그날 처음 그 주제를 열 때 계산한다(조건이 바뀌었거나 기준일이 달라져도 다시 계산). 크론·마이그레이션 없음.
//  · 고객은 '그 상품을 처음 산 날'로 센다 — 한 고객이 하루에만 들어가 기간으로 더해도 겹치지 않는다.
//    신규 = 씨몬스터 첫 주문이 그날, 이후 구매 = 다음 날부터 기준일까지 조건 밖의 상품을 산 고객.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { readKvSoft, readKvStrict, mutateKv } from "./production-kv";
import { isMetaAdConfigured, getDailyByName } from "./meta-ad";
import { isGaConfigured, runGaReport, type GaFilter } from "./ga";
import { readBoard, salesFingerprint } from "./board";
import { BOARD_DAYS, TOPIC_VERSION, TOPIC_MAX, shiftDay as shift, topicCond, topicWords, type BoardTopic, type TopicSnapshot, type TopicSales, type TopicCust, type TopicGa, type TopicMeta, type Fail } from "./board-types";

const KV_TOPICS = "board_topics";
const kvData = (id: string) => `board_topic_${id}`;
const MANUAL_GAP_MS = 60_000;
const ITEM_LIMIT = 20_000;      // 날짜 × 채널 × 상품 줄 수 상한(넘으면 조건이 너무 넓다)
const TOP_ITEMS = 30, TOP_PAGES = 15, TOP_SOURCES = 9, TOP_ADS = 40;
// 저장된 주제가 하나도 없을 때 보이는 기본 주제(대표가 처음 요청한 것). 한 번이라도 저장·삭제하면 저장된 목록만 쓴다.
const DEFAULT_TOPICS: BoardTopic[] = [{ id: "trial", name: "체험단", products: "체험단", pages: "체험단", ads: "체험단" }];

export class TopicError extends Error { constructor(msg: string, public status = 400) { super(msg); this.name = "TopicError"; } }

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v) || 0;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message?: unknown }).message) : String(e));
const fail = (e: unknown): Fail => ({ ok: false, error: errMsg(e).slice(0, 200) });
const timeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 조회 시간 초과(${Math.round(ms / 1000)}초)`)), ms))]);
const zeros = (n: number) => new Array<number>(n).fill(0);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const likeLit = (s: string) => lit(`%${s.replace(/[\\%_]/g, "\\$&")}%`);   // 포함 검색(와일드카드 무력화)
// 조건어 다듬기 — SQL·필터에 그대로 들어가므로 따옴표·세미콜론·역슬래시·제어 문자는 뺀다
const cleanWords = (s: unknown) => topicWords(String(s ?? "").replace(/[\u0000-\u001f;'"\\`]/g, " ")).map((w) => w.replace(/\s+/g, " ").slice(0, 40)).filter(Boolean).join(", ");

async function runQ<T>(sb: SupabaseClient, q: string, limit = 5000): Promise<T[]> {
  const { data, error } = await sb.rpc("run_report", { q, p_limit: limit });
  if (error) throw new Error(`집계 실패: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as T[];
  if (rows.length >= limit) throw new Error("조건에 맞는 줄이 너무 많습니다. 조건을 좁히세요."); // 잘린 결과로 합계를 내지 않는다
  return rows;
}

// ── 주제 목록 ──
const sanitize = (x: unknown): BoardTopic | null => {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const id = String(o.id || "").trim(), name = String(o.name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 20);
  if (!/^[a-z0-9]{1,24}$/.test(id) || !name) return null;
  return { id, name, products: cleanWords(o.products), pages: cleanWords(o.pages), ads: cleanWords(o.ads) };
};
export async function listTopics(): Promise<BoardTopic[]> {
  const r = await readKvStrict<unknown>(KV_TOPICS);
  if (!Array.isArray(r.value)) return DEFAULT_TOPICS;
  return r.value.map(sanitize).filter((t): t is BoardTopic => !!t).slice(0, TOPIC_MAX);
}
const stored = (cur: unknown): BoardTopic[] => (Array.isArray(cur) ? cur.map(sanitize).filter((t): t is BoardTopic => !!t) : DEFAULT_TOPICS.slice());

/** 주제를 만들거나 고친다(id 가 목록에 있으면 고침). 반환 = 저장된 주제와 목록. */
export async function saveTopic(raw: unknown): Promise<{ topic: BoardTopic; topics: BoardTopic[] }> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = String(o.name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 20);
  if (!name) throw new TopicError("주제 이름을 입력하세요.");
  const cond = { products: cleanWords(o.products), pages: cleanWords(o.pages), ads: cleanWords(o.ads) };
  if (!cond.products && !cond.pages && !cond.ads) throw new TopicError("상품, 페이지, 광고 조건 가운데 하나는 입력하세요.");
  const wantId = String(o.id || "").trim();
  const box: { saved: BoardTopic | null } = { saved: null };   // 콜백 안에서 채운다
  const topics = await mutateKv<unknown>(KV_TOPICS, (cur) => {
    const list = stored(cur);
    const at = wantId ? list.findIndex((t) => t.id === wantId) : -1;
    if (list.some((t, i) => i !== at && t.name === name)) throw new TopicError("같은 이름의 주제가 있습니다.");
    if (at >= 0) { box.saved = { id: list[at].id, name, ...cond }; list[at] = box.saved; }
    else {
      if (list.length >= TOPIC_MAX) throw new TopicError(`주제는 ${TOPIC_MAX}개까지 만들 수 있습니다. 안 쓰는 주제를 삭제하세요.`);
      box.saved = { id: `t${Date.now().toString(36)}`, name, ...cond };
      list.push(box.saved);
    }
    return list;
  }) as BoardTopic[];
  if (!box.saved) throw new TopicError("주제를 저장하지 못했습니다.", 500);
  return { topic: box.saved, topics };
}

export async function deleteTopic(id: string): Promise<BoardTopic[]> {
  const topics = await mutateKv<unknown>(KV_TOPICS, (cur) => stored(cur).filter((t) => t.id !== id)) as BoardTopic[];
  if (/^[a-z0-9]{1,24}$/.test(id)) await supabaseAdmin().from("b2b_settings").delete().eq("key", kvData(id)); // 계산해 둔 묶음도 지운다(실패해도 목록 삭제는 끝났다)
  return topics;
}

// ── 매출 ── 조건어가 주문 상품명·옵션·상품코드에 들어 있는 주문 줄.
const prodSql = (words: string[]) => words.map((k) => `o.product_name ilike ${likeLit(k)} or o.option_name ilike ${likeLit(k)} or o.sku_code ilike ${likeLit(k)}`).join(" or ");

async function salesSection(sb: SupabaseClient, words: string[], days: string[], base: string): Promise<TopicSales> {
  const where = `o.order_date between '${days[0]}' and '${base}' and (${prodSql(words)})`;
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
  const total = (c: Cell) => c.rev.reduce((s, x) => s + x, 0);
  const chName = (r: R) => String(r.channel || "").trim() || "기타";

  const byCh = new Map<string, Cell>();
  for (const r of ch) { const i = idx.get(String(r.d)); if (i == null) continue; const k = chName(r); if (!byCh.has(k)) byCh.set(k, cell()); put(byCh.get(k)!, i, r); }
  const channels = [...byCh.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => total(b) - total(a));

  const byItem = new Map<string, Cell & { name: string; channel: string }>();
  for (const r of it) {
    const i = idx.get(String(r.d)); if (i == null) continue;
    const name = String(r.item || "").trim() || "(이름 없음)", channel = chName(r), k = `${channel}\u0001${name}`;
    if (!byItem.has(k)) byItem.set(k, { name, channel, ...cell() });
    put(byItem.get(k)!, i, r);
  }
  const ranked = [...byItem.values()].sort((a, b) => total(b) - total(a));
  const items = ranked.slice(0, TOP_ITEMS);
  // 나머지는 채널마다 '기타' 한 줄로(채널 필터가 그대로 걸리게)
  const rest = new Map<string, Cell & { name: string; channel: string }>();
  for (const r of ranked.slice(TOP_ITEMS)) {
    if (!rest.has(r.channel)) rest.set(r.channel, { name: "기타", channel: r.channel, ...cell() });
    const c = rest.get(r.channel)!;
    for (let i = 0; i < n; i++) { c.rev[i] += r.rev[i]; c.orders[i] += r.orders[i]; c.qty[i] += r.qty[i]; }
  }
  return { ok: true, channels, items: [...items, ...rest.values()] };
}

// ── 고객 ── 그 상품을 처음 산 날 기준(전체 기간에서 첫 구매일을 찾고, 180일 안에 든 고객만 날마다 센다).
async function custSection(sb: SupabaseClient, words: string[], days: string[], base: string): Promise<TopicCust> {
  const prod = prodSql(words);
  const other = `o.order_date > t.first_t and not coalesce((${prod}), false)`;
  const rows = await runQ<{ d: string; n: number; fresh: number; conv: number; conv_rev: number }>(sb,
    `with t as (select o.customer_key, min(o.order_date) as first_t from sales_orders o where o.customer_key <> '' and o.order_date <= '${base}' and (${prod}) group by 1), `
    + `a as (select t.customer_key, t.first_t, min(o.order_date) as first_any, count(distinct o.order_unit) filter (where ${other}) as after_orders, coalesce(sum(o.subtotal_amount) filter (where ${other}), 0) as after_rev `
    + `from t join sales_orders o on o.customer_key = t.customer_key where o.order_date <= '${base}' and t.first_t >= '${days[0]}' group by 1, 2) `
    + `select first_t::text as d, count(*)::int as n, (count(*) filter (where first_any = first_t))::int as fresh, (count(*) filter (where after_orders > 0))::int as conv, coalesce(sum(after_rev), 0)::bigint as conv_rev from a group by 1`);
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const first = zeros(n), fresh = zeros(n), conv = zeros(n), convRev = zeros(n);
  for (const r of rows) { const i = idx.get(String(r.d)); if (i == null) continue; first[i] = num(r.n); fresh[i] = num(r.fresh); conv[i] = num(r.conv); convRev[i] = num(r.conv_rev); }
  return { ok: true, first, fresh, conv, convRev };
}

// ── GA4 ── 조건어가 페이지 제목 또는 주소에 든 페이지. 날짜 × 주소(조회·방문), 날짜 × 소스/매체(방문).
//  방문은 그 페이지를 본 세션 수 — 주소가 여럿이면 한 방문이 주소마다 세어져 합계가 조금 커질 수 있다(조회는 정확히 더해진다).
async function gaSection(words: string[], days: string[], base: string): Promise<TopicGa> {
  const filterAny: GaFilter[] = words.flatMap((w): GaFilter[] => [{ dimension: "page_title", match: "contains", value: w }, { dimension: "page_path", match: "contains", value: w }]);
  const common = { since: days[0], until: base, limit: 5000, filterAny };
  const [pg, src] = await timeout(Promise.all([
    runGaReport({ ...common, dimensions: ["date", "page_path"], metrics: ["page_views", "sessions"] }),
    runGaReport({ ...common, dimensions: ["date", "source_medium"], metrics: ["sessions"] }),
  ]), 45_000, "GA4");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const pMap = new Map<string, { views: number[]; sessions: number[] }>();
  { const [cD, cP, cV, cS] = pg.columns;
    for (const r of pg.rows) { const i = idx.get(String(r[cD])); if (i == null) continue; const k = String(r[cP] || "") || "(없음)"; if (!pMap.has(k)) pMap.set(k, { views: zeros(n), sessions: zeros(n) }); const c = pMap.get(k)!; c.views[i] += num(r[cV]); c.sessions[i] += num(r[cS]); } }
  const sMap = new Map<string, { sessions: number[] }>();
  { const [cD, cM, cS] = src.columns;
    for (const r of src.rows) { const i = idx.get(String(r[cD])); if (i == null) continue; const k = String(r[cM] || "") || "(없음)"; if (!sMap.has(k)) sMap.set(k, { sessions: zeros(n) }); sMap.get(k)!.sessions[i] += num(r[cS]); } }
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const pRank = [...pMap.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => sum(b.views) - sum(a.views));
  const pages = pRank.slice(0, TOP_PAGES), pRest = pRank.slice(TOP_PAGES);
  if (pRest.length) pages.push({ name: "기타", views: days.map((_, i) => pRest.reduce((s, c) => s + c.views[i], 0)), sessions: days.map((_, i) => pRest.reduce((s, c) => s + c.sessions[i], 0)) });
  const sRank = [...sMap.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => sum(b.sessions) - sum(a.sessions));
  const sources = sRank.slice(0, TOP_SOURCES), sRest = sRank.slice(TOP_SOURCES);
  if (sRest.length) sources.push({ name: "기타", sessions: days.map((_, i) => sRest.reduce((s, c) => s + c.sessions[i], 0)) });
  return { ok: true, pages, sources, truncated: pg.truncated || src.truncated };
}

// ── 메타 광고 ── 조건어가 캠페인·광고 세트·광고 이름에 든 광고. 60일씩 나눠 받는다(일별 × 광고는 줄이 많다).
async function metaSection(words: string[], days: string[]): Promise<TopicMeta> {
  const parts: { since: string; until: string }[] = [];
  for (let i = 0; i < days.length; i += 60) parts.push({ since: days[i], until: days[Math.min(i + 59, days.length - 1)] });
  const res = await timeout(Promise.all(parts.map((p) => getDailyByName(p, words))), 70_000, "메타 광고");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  type Ad = TopicMeta["ads"][number];
  const by = new Map<string, Ad>();
  for (const r of res.flatMap((x) => x.rows)) {
    const i = idx.get(r.date); if (i == null) continue;
    if (!by.has(r.id)) by.set(r.id, { id: r.id, campaign: r.campaign, adset: r.adset, name: r.name, spend: zeros(n), impressions: zeros(n), clicks: zeros(n), purchases: zeros(n), value: zeros(n) });
    const a = by.get(r.id)!;
    a.spend[i] += Math.round(num(r.spend)); a.impressions[i] += num(r.impressions); a.clicks[i] += num(r.clicks); a.purchases[i] += num(r.purchases); a.value[i] += Math.round(num(r.purchaseValue));
  }
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const ranked = [...by.values()].sort((a, b) => sum(b.spend) - sum(a.spend));
  const ads = ranked.slice(0, TOP_ADS), rest = ranked.slice(TOP_ADS);
  if (rest.length) {
    const pick = (k: "spend" | "impressions" | "clicks" | "purchases" | "value") => days.map((_, i) => rest.reduce((s, a) => s + a[k][i], 0));
    ads.push({ id: "rest", campaign: "", adset: "", name: `기타 ${rest.length}개`, spend: pick("spend"), impressions: pick("impressions"), clicks: pick("clicks"), purchases: pick("purchases"), value: pick("value") });
  }
  return { ok: true, ads, campaignOnly: res.some((x) => x.campaignOnly) };
}

export async function buildTopic(sb: SupabaseClient, topic: BoardTopic, base: string): Promise<TopicSnapshot> {
  const days = Array.from({ length: BOARD_DAYS }, (_, i) => shift(base, i - (BOARD_DAYS - 1)));
  const pw = topicWords(topic.products), gw = topicWords(topic.pages), aw = topicWords(topic.ads);
  const [sales, cust, ga, meta] = await Promise.all([
    pw.length ? salesSection(sb, pw, days, base).catch(fail) : Promise.resolve(null),
    pw.length ? custSection(sb, pw, days, base).catch(fail) : Promise.resolve(null),
    gw.length && isGaConfigured() ? gaSection(gw, days, base).catch(fail) : Promise.resolve(null),
    aw.length && isMetaAdConfigured() ? metaSection(aw, days).catch(fail) : Promise.resolve(null),
  ]);
  return { v: TOPIC_VERSION, id: topic.id, cond: topicCond(topic), base, builtAt: new Date().toISOString(), builtDay: kstToday(), days, sales, cust, ga, meta };
}

/** 주제 하나의 묶음 — 저장된 것이 오늘 계산됐고 조건·기준일이 같으면 그대로, 아니면 계산해 저장한다. force = [다시 계산](1분 안 연타 거절). */
export async function topicData(id: string, opts: { force?: boolean } = {}): Promise<{ topic: BoardTopic; data: TopicSnapshot }> {
  const topic = (await listTopics()).find((t) => t.id === id);
  if (!topic) throw new TopicError("없는 주제입니다. 화면을 새로 고치세요.", 404);
  const sb = supabaseAdmin();
  const base = (await readBoard())?.base ?? (await salesFingerprint(sb)).base;   // 본 묶음과 같은 기준일
  const old = (await readKvSoft<TopicSnapshot>(kvData(id))).value;
  const usable = !!old && old.v === TOPIC_VERSION && Array.isArray(old.days) && old.cond === topicCond(topic);
  if (usable && old) {
    if (opts.force && Date.now() - Date.parse(old.builtAt) < MANUAL_GAP_MS) throw new TopicError("방금 계산했습니다. 1분 뒤에 다시 누르세요.", 409);
    if (!opts.force && old.base === base && old.builtDay === kstToday()) return { topic, data: old };
  }
  const data = await buildTopic(sb, topic, base);
  await mutateKv<TopicSnapshot>(kvData(id), () => data);
  return { topic, data };
}
