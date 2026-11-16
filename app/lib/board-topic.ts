// 주요 지표 주제 보고서(2026-11-16) — 주제 하나(예: 체험단)의 구매·광고 효율·페이지 전환·재구매를 모은다. 서버 전용.
//  대표가 이 화면으로 알고 싶은 것: ① 체험단 구매가 얼마나 생기는가 ② 구매를 유도하는 광고의 효율 ③ 체험단 페이지의 전환율과 병목 ④ 체험 이후 재구매(만족).
//  · 주제 정의는 board-types.ts 의 TOPICS(대표와 같이 정한 정확한 대상). 화면에서 만들거나 고치지 않는다.
//  · 계산한 묶음은 주제마다 b2b_settings kv `board_topic_<id>`. 본 묶음과 같은 기준일·같은 180일. 화면이 기간을 잘라 쓴다.
//  · 하루 한 번: 그날 처음 그 주제를 열 때 계산한다(정의나 기준일이 달라져도 다시 계산). 크론·마이그레이션 없음.
//  · 고객은 '그 상품을 처음 산 날'로 센다 — 한 고객이 하루에만 들어가 기간으로 더해도 겹치지 않는다.
//    신규 = 씨몬스터 첫 주문이 그날, 재구매 = 다음 날부터 주제 밖의 상품을 산 고객(30일 안 / 기준일까지).
//  · 페이지 단계의 단위가 다르다: 방문·스크롤 = GA4 세션, 주문서 진입 = GA4 상품 결제 시작 수량, 구매 = 매출 원장의 주문 건수.
//  · 폼 신청형 주제(def.forms — 다이어트 챌린지): 전환이 상품 주문이 아니라 탈리 폼 제출이다. 매출·고객 집계 대신 formsSection 이
//    탈리 API 에서 신청·결과 제출을 받아 날짜별 건수로 만든다. 신청한 사람과 결과·구매는 전화번호로 잇는다(저장은 건수만).
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { readKvSoft, mutateKv } from "./production-kv";
import { isMetaAdConfigured, getDailyByName } from "./meta-ad";
import { isGaConfigured, runGaReport, type GaFilter } from "./ga";
import { readBoard, salesFingerprint } from "./board";
import { BOARD_DAYS, TOPIC_VERSION, TOPICS, TOPIC_REPEAT_DAYS, TOPIC_OPINION_MAX, shiftDay as shift, type TopicDef, type TopicSnapshot, type TopicSales, type TopicCust, type TopicGa, type TopicMeta, type TopicForms, type TopicSubmit, type Fail } from "./board-types";
import { getTallyApiKey, tallyFetch, mapTallySubmission, type TallyQ, type TallySub } from "./voc-tally";
import { findPhone } from "./form-sms";
import { customerKey } from "./sales-normalize";

const kvData = (id: string) => `board_topic_${id}`;
const MANUAL_GAP_MS = 60_000;
const ITEM_LIMIT = 20_000;      // 날짜 × 채널 × 상품 줄 수 상한(넘으면 정의가 너무 넓다)
const TOP_ITEMS = 30, TOP_AFTER = 15, TOP_SOURCES = 12, TOP_ADS = 40;
const FORM_PAGES = 30;          // 탈리 제출 100건씩 최대 30쪽(3,000건) — 넘으면 일부만 받았다고 알린다
const KEY_CHUNK = 200;          // 고객 키를 한 번에 이만큼씩 조회

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
    runQ<R & { item: string }>(sb, `select o.order_date::text as d, o.channel, case when o.option_name <> '' then o.product_name || ' / ' || o.option_name else o.product_name end as item, ${sums} from sales_orders o where ${where} group by 1, 2, 3`, ITEM_LIMIT),   // 상품명 / 옵션 — 어떤 구성이 팔리는지
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

// ── 탈리 폼(신청·결과) ── 180일 안의 제출을 받아 날짜별 건수로. 신청한 사람(전화번호)에 결과 제출과 주문을 잇는다.
//  사람의 날짜 = 처음 신청한 날(한 사람은 하루에만 들어가 기간으로 더해도 겹치지 않는다). 구매 = 그날부터 기준일까지의 주문(모든 채널).
type FormSub = { day: string; phone: string | null; scales: [qid: string, score: number][]; texts: [qid: string, text: string][] };   // scales = 척도 문항의 점수, texts = 글로 답한 문항(의견 목록용 — 쓰는 쪽이 문항을 골라 담는다)
const OPINION_CHARS = 600;   // 의견 한 편의 최대 길이
const EMPTY_OPINION = /^(딱히\s*)?(없음|없습니다|없어요|없네요|없다|없어용)?[\s.!~\-xX]*$/;   // '없음' 같은 빈 답은 의견으로 치지 않는다
const kstDay = (iso: string | undefined) => { const t = Date.parse(String(iso || "")); return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : ""; };
async function tallySubs(formId: string, startIso: string, apiKey: string): Promise<{ subs: FormSub[]; truncated: boolean; questions: TallyQ[] }> {
  const qmap = new Map<string, TallyQ>();
  const subs: FormSub[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= FORM_PAGES; page++) {
    const json = await tallyFetch(`/forms/${encodeURIComponent(formId)}/submissions?filter=completed&limit=100&page=${page}&startDate=${encodeURIComponent(startIso)}`, apiKey);
    for (const q of (json.questions || []) as TallyQ[]) if (q.id) qmap.set(q.id, q);
    const list = (json.submissions || []) as TallySub[];
    for (const s of list) {
      if (!s?.id || seen.has(s.id)) continue;
      seen.add(s.id);
      const day = kstDay(s.submittedAt);
      if (!day) continue;
      const scales: [string, number][] = [], texts: [string, string][] = [];
      for (const r of s.responses || []) {
        if (/SCALE|RATING/i.test(qmap.get(r.questionId)?.type || "")) {   // 척도 문항 — 점수가 글자로 와도 숫자로 읽는다
          const v = Number(r.answer);
          if (Number.isFinite(v) && v > 0) scales.push([r.questionId, v]);
        } else if (typeof r.answer === "string") {
          const tx = r.answer.trim();
          if (tx && !EMPTY_OPINION.test(tx)) texts.push([r.questionId, tx.slice(0, OPINION_CHARS)]);
        }
      }
      subs.push({ day, phone: findPhone(mapTallySubmission(s, qmap, formId).answers), scales, texts });
    }
    if (!json.hasMore || list.length === 0) return { subs, truncated: false, questions: [...qmap.values()] };
  }
  return { subs, truncated: true, questions: [...qmap.values()] };
}
async function formsSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicForms> {
  const f = def.forms!;
  const apiKey = await getTallyApiKey();
  if (!apiKey) throw new Error("탈리 API 키가 없습니다. VOC › 설정에서 탈리 API 키를 넣으세요.");
  const startIso = new Date(`${days[0]}T00:00:00+09:00`).toISOString();
  const [ap, rs] = await timeout(Promise.all([
    tallySubs(f.apply.id, startIso, apiKey),
    f.result ? tallySubs(f.result.id, startIso, apiKey) : Promise.resolve(null),
  ]), 60_000, "탈리");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const out: TopicForms = { ok: true, apply: zeros(n), people: zeros(n), result: rs ? zeros(n) : null, done: zeros(n), buy: { ok: true, people: zeros(n), rev: zeros(n) }, noPhone: 0, resultUnmatched: 0, truncated: ap.truncated || !!rs?.truncated };

  // 신청 — 사람마다 처음 신청한 날
  const firstDay = new Map<string, string>();   // 전화번호 → 처음 신청한 날
  for (const s of ap.subs) {
    const i = idx.get(s.day); if (i == null) continue;   // 기준일 뒤(오늘) 제출은 다음 계산에
    out.apply[i]++;
    if (!s.phone) { out.noPhone++; out.people[i]++; continue; }
    const cur = firstDay.get(s.phone);
    if (!cur || s.day < cur) firstDay.set(s.phone, s.day);
  }
  for (const d of firstDay.values()) out.people[idx.get(d)!]++;

  // 결과 — 날짜별 제출 건수와, 신청한 사람 가운데 결과를 낸 사람(신청일 자리에)
  if (rs && out.result) {
    const doneBy = new Set<string>();
    for (const s of rs.subs) {
      const i = idx.get(s.day); if (i == null) continue;
      out.result[i]++;
      if (s.phone && firstDay.has(s.phone)) doneBy.add(s.phone); else out.resultUnmatched++;
    }
    for (const p of doneBy) out.done[idx.get(firstDay.get(p)!)!]++;
  }

  // 구매 — 신청한 사람의 고객 키로 주문 원장을 본다. 실패해도 신청·결과 숫자는 그대로 보여 준다.
  try {
    const byKey = new Map<string, string>();   // 고객 키 → 처음 신청한 날
    for (const [phone, d] of firstDay) { const k = customerKey(phone); if (k) byKey.set(k, d); }
    const keys = [...byKey.keys()];
    const people = zeros(n), rev = zeros(n);
    for (let c = 0; c < keys.length; c += KEY_CHUNK) {
      const rows = await runQ<{ k: string; d: string; rev: number }>(sb,
        `select o.customer_key as k, o.order_date::text as d, coalesce(sum(o.subtotal_amount), 0)::bigint as rev from sales_orders o `
        + `where o.customer_key in (${keys.slice(c, c + KEY_CHUNK).map(lit).join(", ")}) and o.order_date between '${days[0]}' and '${base}' group by 1, 2`, ITEM_LIMIT);
      const got = new Map<string, number>();   // 고객 키 → 신청한 날부터의 매출
      for (const r of rows) { const d0 = byKey.get(String(r.k)); if (d0 && String(r.d) >= d0) got.set(String(r.k), (got.get(String(r.k)) || 0) + num(r.rev)); }
      for (const [k, v] of got) { const i = idx.get(byKey.get(k)!)!; people[i]++; rev[i] += v; }
    }
    out.buy = { ok: true, people, rev };
  } catch (e) { out.buy = fail(e); }
  return out;
}

// ── 결과 제출 폼(상품 주문형 주제 — 이유식 체험단) ── 날짜별 제출 건수와, 그 상품을 산 고객 가운데 결과를 낸 사람(처음 산 날 자리에).
//  제출한 사람의 전화번호 → 고객 키로 그 상품의 첫 구매일을 찾는다(custSection 의 '처음 산 날'과 같은 기준이라 처음 산 고객 수로 나눌 수 있다).
async function submitSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicSubmit> {
  const apiKey = await getTallyApiKey();
  if (!apiKey) throw new Error("탈리 API 키가 없습니다. VOC › 설정에서 탈리 API 키를 넣으세요.");
  const rs = await timeout(tallySubs(def.submit!.id, new Date(`${days[0]}T00:00:00+09:00`).toISOString(), apiKey), 60_000, "탈리");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const out: TopicSubmit = { ok: true, count: zeros(n), done: zeros(n), unmatched: 0, truncated: rs.truncated, survey: [], surveyAnswered: zeros(n), opinions: [] };
  // 설문 척도 문항 — 폼의 순서대로. 이름은 정의에 적어 둔 짧은 이름(없으면 문항 제목 그대로)
  const names = def.submit!.scaleNames || [];
  const scaleQ = new Map<string, TopicSubmit["survey"][number]>();
  if (def.submit!.scaleMax) for (const q of rs.questions) {
    if (!/SCALE|RATING/i.test(q.type || "")) continue;
    const title = (q.title || "").replace(/\s+/g, " ").trim();
    scaleQ.set(q.id, { label: names.find(([m]) => title.includes(m))?.[1] || title || "(제목 없음)", sum: zeros(n), n: zeros(n) });
  }
  // 주관식 의견 — 정의에 적은 문항만(이름·연락처 같은 다른 글 답은 담지 않는다)
  const textQ = new Map<string, string>();   // 문항 id → 화면에 쓸 이름
  for (const q of rs.questions) {
    const title = (q.title || "").replace(/\s+/g, " ").trim();
    const hit = (def.submit!.textNames || []).find(([m]) => title.includes(m));
    if (hit) textQ.set(q.id, hit[1]);
  }
  const byKey = new Map<string, number>();   // 고객 키 → 제출 건수
  for (const s of rs.subs) {
    const i = idx.get(s.day); if (i == null) continue;   // 기준일 뒤(오늘) 제출은 다음 계산에
    out.count[i]++;
    let scoreSum = 0, scoreN = 0;
    for (const [qid, v] of s.scales) { const q = scaleQ.get(qid); if (q) { q.sum[i] += v; q.n[i]++; scoreSum += v; scoreN++; } }
    if (scoreN > 0) out.surveyAnswered[i]++;
    const parts = s.texts.flatMap(([qid, tx]): [string, string][] => { const name = textQ.get(qid); return name ? [[name, tx]] : []; });
    if (parts.length) out.opinions.push({ day: s.day, score: scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null, parts });
    const k = s.phone ? customerKey(s.phone) : "";
    if (!k) { out.unmatched++; continue; }
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  const keys = [...byKey.keys()], firstBy = new Map<string, string>();   // 고객 키 → 그 상품을 처음 산 날
  for (let c = 0; c < keys.length; c += KEY_CHUNK) {
    const rows = await runQ<{ k: string; d: string }>(sb,
      `select o.customer_key as k, min(o.order_date)::text as d from sales_orders o `
      + `where o.customer_key in (${keys.slice(c, c + KEY_CHUNK).map(lit).join(", ")}) and o.order_date <= '${base}' and (${prodSql(def)}) group by 1`);
    for (const r of rows) firstBy.set(String(r.k), String(r.d));
  }
  for (const [k, cnt] of byKey) {
    const d = firstBy.get(k);
    if (!d) { out.unmatched += cnt; continue; }
    const i = idx.get(d); if (i != null) out.done[i]++;   // 180일보다 먼저 산 고객은 이은 것으로 보되 날짜 칸에는 넣지 않는다
  }
  out.survey = [...scaleQ.values()].filter((q) => sum(q.n) > 0);
  out.opinions = out.opinions.map((o, k) => ({ o, k })).sort((a, b) => (a.o.day < b.o.day ? 1 : a.o.day > b.o.day ? -1 : a.k - b.k)).slice(0, TOPIC_OPINION_MAX).map((x) => x.o);   // 최근 것부터
  return out;
}

export async function buildTopic(sb: SupabaseClient, def: TopicDef, base: string): Promise<TopicSnapshot> {
  const days = Array.from({ length: BOARD_DAYS }, (_, i) => shift(base, i - (BOARD_DAYS - 1)));
  const isForm = !!def.forms;   // 폼 신청형 — 상품 주문·고객 집계를 하지 않는다
  const [sales, cust, ga, meta, forms, submit] = await Promise.all([
    isForm ? Promise.resolve(null) : salesSection(sb, def, days, base).catch(fail),
    isForm ? Promise.resolve(null) : custSection(sb, def, days, base).catch(fail),
    def.landing && isGaConfigured() ? gaSection(def, days, base).catch(fail) : Promise.resolve(null),
    def.metaCampaignLike.length && isMetaAdConfigured() ? metaSection(def, days).catch(fail) : Promise.resolve(null),
    isForm ? formsSection(sb, def, days, base).catch(fail) : Promise.resolve(null),
    !isForm && def.submit ? submitSection(sb, def, days, base).catch(fail) : Promise.resolve(null),
  ]);
  return { v: TOPIC_VERSION, id: def.id, cond: JSON.stringify(def), base, builtAt: new Date().toISOString(), builtDay: kstToday(), days, sales, cust, ga, meta, forms, submit };
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
