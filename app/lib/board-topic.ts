// 주요 지표 주제 보고서(2026-11-16) — 주제 하나(예: 체험단)의 구매·광고 효율·페이지 전환·재구매를 모은다. 서버 전용.
//  대표가 이 화면으로 알고 싶은 것: ① 체험단 구매가 얼마나 생기는가 ② 구매를 유도하는 광고의 효율 ③ 체험단 페이지의 전환율과 병목 ④ 체험 이후 재구매(만족).
//  · 주제 정의는 board-types.ts 의 TOPICS(대표와 같이 정한 정확한 대상). 화면에서 만들거나 고치지 않는다.
//  · 계산한 묶음은 주제마다 b2b_settings kv `board_topic_<id>`. 본 묶음과 같은 기준일·같은 180일. 화면이 기간을 잘라 쓴다.
//  · 하루 한 번: 그날 처음 그 주제를 열 때 계산한다(정의나 기준일이 달라져도 다시 계산). 크론·마이그레이션 없음.
//  · 고객은 '그 상품을 처음 산 날'로 센다 — 한 고객이 하루에만 들어가 기간으로 더해도 겹치지 않는다.
//    신규 = 씨몬스터 첫 주문이 그날, 재구매 = 다음 날부터 기준일까지 주제 밖의 상품을 주문한 고객(1번 이상 = 재구매, 2번 이상 = 재재구매).
//  · 재구매 추적은 전체 기간으로 본다(2026-11-17 대표) — 날짜 칸은 180일 안, total 은 그 밖까지 포함. 결과 제출 폼이 있으면 미션을 마친 사람이 기준이다.
//  · 페이지 단계의 단위가 다르다: 방문·스크롤 = GA4 세션, 주문서 진입 = GA4 상품 결제 시작 수량, 구매 = 매출 원장의 주문 건수.
//  · 폼 신청형 주제(def.forms — 다이어트 챌린지): 전환이 상품 주문이 아니라 탈리 폼 제출이다. 매출·고객 집계 대신 formsSection 이
//    탈리 API 에서 신청·결과 제출을 받아 날짜별 건수로 만든다. 신청한 사람과 결과·구매는 전화번호로 잇는다(저장은 건수만).
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { readKvSoft, mutateKv } from "./production-kv";
import { isMetaAdConfigured, getDailyByName } from "./meta-ad";
import { isGaConfigured, runGaReport, type GaFilter } from "./ga";
import { readBoard, salesFingerprint } from "./board";
import { BOARD_DAYS, TOPIC_VERSION, TOPICS, TOPIC_OPINION_MAX, shiftDay as shift, type TopicDef, type TopicSnapshot, type TopicSales, type TopicCust, type TopicGa, type TopicMeta, type TopicForms, type TopicSubmit, type Fail } from "./board-types";
import { getTallyApiKey, tallyFetch, mapTallySubmission, type TallyQ, type TallySub } from "./voc-tally";
import { findPhone, PHONE_LABEL } from "./form-sms";
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
// 그 고객(t)이 처음 산 다음 날부터 주제 밖의 상품을 산 주문 줄
const otherSql = (def: TopicDef) => `o.order_date > t.first_t and not coalesce((${prodSql(def)}), false)`;

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

// ── 고객 ── 처음 산 날 기준. 전체 기간에서 첫 구매일을 찾아 날마다 세고(180일 밖은 total 에만), 그 뒤 주제 밖 상품의 주문 수로 재구매(1번 이상)·재재구매(2번 이상)를 가른다.
async function custSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicCust> {
  const prod = prodSql(def);
  const first = `select o.customer_key, min(o.order_date) as first_t from sales_orders o where o.customer_key <> '' and o.order_date <= '${base}' and (${prod}) group by 1`;
  const other = otherSql(def);
  const [rows, after] = await Promise.all([
    runQ<{ d: string; n: number; fresh: number; rep1: number; rep2: number; rep_rev: number }>(sb,
      `with t as (${first}), `
      + `a as (select t.customer_key, t.first_t, min(o.order_date) as first_any, count(distinct o.order_unit) filter (where ${other}) as after_n, coalesce(sum(o.subtotal_amount) filter (where ${other}), 0) as after_rev `
      + `from t join sales_orders o on o.customer_key = t.customer_key where o.order_date <= '${base}' group by 1, 2) `
      + `select first_t::text as d, count(*)::int as n, (count(*) filter (where first_any = first_t))::int as fresh, (count(*) filter (where after_n >= 1))::int as rep1, `
      + `(count(*) filter (where after_n >= 2))::int as rep2, coalesce(sum(after_rev), 0)::bigint as rep_rev from a group by 1`),
    runQ<{ d: string; item: string; n: number; rev: number }>(sb,
      `with t as (${first}) select t.first_t::text as d, o.product_name as item, count(distinct t.customer_key)::int as n, coalesce(sum(o.subtotal_amount), 0)::bigint as rev `
      + `from t join sales_orders o on o.customer_key = t.customer_key where t.first_t >= '${days[0]}' and o.order_date <= '${base}' and ${other} group by 1, 2`, ITEM_LIMIT),
  ]);
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const out: TopicCust = { ok: true, first: zeros(n), fresh: zeros(n), rep1: zeros(n), rep2: zeros(n), repRev: zeros(n), total: { first: 0, rep1: 0, rep2: 0 }, after: [] };
  for (const r of rows) {
    out.total.first += num(r.n); out.total.rep1 += num(r.rep1); out.total.rep2 += num(r.rep2);
    const i = idx.get(String(r.d)); if (i == null) continue;   // 180일보다 먼저 처음 산 고객 — 전체 기간 합계에만
    out.first[i] = num(r.n); out.fresh[i] = num(r.fresh); out.rep1[i] = num(r.rep1); out.rep2[i] = num(r.rep2); out.repRev[i] = num(r.rep_rev);
  }
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

// ── 탈리 폼(신청·결과) ── 전체 기간의 제출을 받는다(전체 기간 합계 total 을 내려고). 날짜 칸에는 180일 안의 것만 넣는다.
//  사람의 날짜 = 처음 신청한 날(한 사람은 하루에만 들어가 기간으로 더해도 겹치지 않는다). 구매 = 그날부터 기준일까지의 주문(모든 채널).
//  재구매·재재구매 = 미션을 마친(결과를 낸) 사람이 결과를 낸 다음 날부터 한 주문이 1번 이상·2번 이상.
type FormSub = { day: string; phone: string | null; shape: string; scales: [qid: string, score: number][]; texts: [qid: string, text: string][] };   // shape = 번호를 못 읽었을 때 그 답의 모양(숫자를 9 로 가린 것 — 점검용)   // scales = 척도 문항의 점수, texts = 글로 답한 문항(의견 목록용 — 쓰는 쪽이 문항을 골라 담는다)
const OPINION_CHARS = 600;   // 의견 한 편의 최대 길이
const EMPTY_OPINION = /^(딱히\s*)?(없음|없습니다|없어요|없네요|없다|없어용)?[\s.!~\-xX]*$/;   // '없음' 같은 빈 답은 의견으로 치지 않는다
// 구매와 잇는 데 쓸 번호(2026-11-18 대표: "뒷 8자리를 토대로 추적") — 휴대폰 번호로 읽히면 그대로, 아니면 연락처 답의 뒷 8자리에 010 을 붙인다.
//  폼에 82… 로 들어오든 010-… 으로 들어오든, 앞에 다른 숫자가 붙었든 같은 번호가 된다. 주문 쪽 고객 키는 주문자 번호(010…) 전체로 만든 것이라 그대로 맞는다.
//  문자를 보내는 데는 쓰지 않는다(추정이 섞인다) — 잇기 전용.
function matchPhone(answers: { label?: string; value?: unknown }[]): string | null {
  const strict = findPhone(answers);
  if (strict) return strict;
  const tail = (v: unknown) => {
    const raw = String(v ?? "").trim(), d = raw.replace(/\D/g, "");
    return /^[+\d][\d\s\-().]{7,22}$/.test(raw) && d.length >= 10 && d.length <= 14 ? `010${d.slice(-8)}` : null;
  };
  for (const a of answers) if (PHONE_LABEL.test(String(a?.label ?? ""))) { const t = tail(a?.value); if (t) return t; }
  for (const a of answers) { const t = tail(a?.value); if (t) return t; }
  return null;
}
const kstDay = (iso: string | undefined) => { const t = Date.parse(String(iso || "")); return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : ""; };
async function tallySubs(formId: string, apiKey: string): Promise<{ subs: FormSub[]; truncated: boolean; questions: TallyQ[] }> {
  const qmap = new Map<string, TallyQ>();
  const subs: FormSub[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= FORM_PAGES; page++) {
    const json = await tallyFetch(`/forms/${encodeURIComponent(formId)}/submissions?filter=completed&limit=100&page=${page}`, apiKey);
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
      const answers = (mapTallySubmission(s, qmap, formId).answers || []) as { label?: string; value?: unknown }[];
      const phone = matchPhone(answers);
      let shape = "";
      if (!phone) {   // 점검용 — 못 읽은 답의 모양(숫자는 9 로 가림). 연락처 문항이 안 보이면 그 제출에 든 문항 제목을 남긴다(제목은 개인정보가 아니다)
        const a = answers.find((x) => PHONE_LABEL.test(String(x?.label ?? "")));
        // 연락처 문항이 안 보이면 답마다 '제목 앞머리:값의 모양'(숫자 9·글자 x 로 가림) — 번호가 다른 답 안에 들어 있는지 본다
        const mask = (v: unknown) => String(v ?? "").replace(/\d/g, "9").replace(/[A-Za-z가-힣]/g, "x").slice(0, 18);
        shape = a ? (String(a.value ?? "").replace(/\d/g, "9").slice(0, 24) || "(빈 값)") : `(연락처 문항 없음 ${answers.length}) ${answers.slice(0, 4).map((x) => `${String(x?.label ?? "").slice(4, 9) || "제목없음"}:${mask(x?.value)}`).join(" | ")}`;
      }
      subs.push({ day, phone, shape, scales, texts });
    }
    if (!json.hasMore || list.length === 0) return { subs, truncated: false, questions: [...qmap.values()] };
  }
  return { subs, truncated: true, questions: [...qmap.values()] };
}
// 의견 목록에 쓸 주관식 문항(정의에 적은 것만) — 문항 id → 화면에 쓸 이름. 이름·연락처 같은 다른 글 답은 담지 않는다
function textQuestions(questions: TallyQ[], names: [string, string][] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const q of questions) {
    const title = (q.title || "").replace(/\s+/g, " ").trim();
    const hit = (names || []).find(([m]) => title.includes(m));
    if (hit) out.set(q.id, hit[1]);
  }
  return out;
}
const opinionParts = (s: FormSub, textQ: Map<string, string>) => s.texts.flatMap(([qid, tx]): [string, string][] => { const name = textQ.get(qid); return name ? [[name, tx]] : []; });
type Opinion = TopicSubmit["opinions"][number];
const newestFirst = (list: Opinion[]) => list.map((o, k) => ({ o, k })).sort((a, b) => (a.o.day < b.o.day ? 1 : a.o.day > b.o.day ? -1 : a.k - b.k)).slice(0, TOPIC_OPINION_MAX).map((x) => x.o);

async function formsSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicForms> {
  const f = def.forms!;
  const apiKey = await getTallyApiKey();
  if (!apiKey) throw new Error("탈리 API 키가 없습니다. VOC › 설정에서 탈리 API 키를 넣으세요.");
  const [ap, rs] = await timeout(Promise.all([
    tallySubs(f.apply.id, apiKey),
    f.result ? tallySubs(f.result.id, apiKey) : Promise.resolve(null),
  ]), 60_000, "탈리");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const out: TopicForms = { ok: true, apply: zeros(n), people: zeros(n), result: rs ? zeros(n) : null, done: zeros(n),
    buy: { ok: true, people: zeros(n), rev: zeros(n), rep1: zeros(n), rep2: zeros(n), repRev: zeros(n), total: { buy: 0, rep1: 0, rep2: 0 } },
    total: { people: 0, done: 0 }, opinions: [], noPhone: 0, resultUnmatched: 0, truncated: ap.truncated || !!rs?.truncated };

  // 신청 — 사람마다 처음 신청한 날
  const firstDay = new Map<string, string>();   // 전화번호 → 처음 신청한 날
  for (const s of ap.subs) {
    if (s.day > base) continue;   // 기준일 뒤(오늘) 제출은 다음 계산에
    const i = idx.get(s.day);     // 180일보다 앞선 제출은 날짜 칸 없이 전체 기간 합계에만
    if (i != null) out.apply[i]++;
    if (!s.phone) { out.total.people++; if (i != null) { out.noPhone++; out.people[i]++; } continue; }
    const cur = firstDay.get(s.phone);
    if (!cur || s.day < cur) firstDay.set(s.phone, s.day);
  }
  for (const d of firstDay.values()) { out.total.people++; const i = idx.get(d); if (i != null) out.people[i]++; }

  // 결과 — 날짜별 제출 건수와, 신청한 사람 가운데 결과를 낸 사람(신청일 자리에). 결과를 처음 낸 날이 재구매를 세는 기준이 된다.
  const resultDay = new Map<string, string>();   // 전화번호 → 처음 결과를 낸 날(신청한 사람만)
  if (rs && out.result) {
    const textQ = textQuestions(rs.questions, f.result?.textNames);
    for (const s of rs.subs) {
      if (s.day > base) continue;
      const known = !!s.phone && firstDay.has(s.phone);
      if (known) { const cur = resultDay.get(s.phone!); if (!cur || s.day < cur) resultDay.set(s.phone!, s.day); }
      const i = idx.get(s.day); if (i == null) continue;
      out.result[i]++;
      if (!known) out.resultUnmatched++;
      const parts = opinionParts(s, textQ);
      if (parts.length) out.opinions.push({ day: s.day, score: null, parts });
    }
    for (const p of resultDay.keys()) { out.total.done++; const i = idx.get(firstDay.get(p)!); if (i != null) out.done[i]++; }
    out.opinions = newestFirst(out.opinions);
  }

  // 주문 — 신청한 사람의 고객 키로 주문 원장을 본다. 실패해도 신청·결과 숫자는 그대로 보여 준다.
  try {
    const byKey = new Map<string, { apply: string; result: string | null }>();   // 고객 키 → 처음 신청한 날·처음 결과를 낸 날
    for (const [phone, d] of firstDay) { const k = customerKey(phone); if (k) byKey.set(k, { apply: d, result: resultDay.get(phone) ?? null }); }
    const keys = [...byKey.keys()];
    let lo = base; for (const m of byKey.values()) if (m.apply < lo) lo = m.apply;   // 가장 이른 신청일부터
    const buy: Extract<TopicForms["buy"], { ok: true }> = { ok: true, people: zeros(n), rev: zeros(n), rep1: zeros(n), rep2: zeros(n), repRev: zeros(n), total: { buy: 0, rep1: 0, rep2: 0 } };
    for (let c = 0; c < keys.length; c += KEY_CHUNK) {
      const rows = await runQ<{ k: string; d: string; rev: number; n: number }>(sb,
        `select o.customer_key as k, o.order_date::text as d, coalesce(sum(o.subtotal_amount), 0)::bigint as rev, count(distinct o.order_unit)::int as n from sales_orders o `
        + `where o.customer_key in (${keys.slice(c, c + KEY_CHUNK).map(lit).join(", ")}) and o.order_date between '${lo}' and '${base}' group by 1, 2`, ITEM_LIMIT);
      const agg = new Map<string, { buyRev: number; repN: number; repRev: number }>();   // 고객 키 → 신청한 날부터의 매출, 결과를 낸 뒤의 주문 수·매출
      for (const r of rows) {
        const k = String(r.k), d = String(r.d), m = byKey.get(k);
        if (!m || d < m.apply) continue;
        const a = agg.get(k) || { buyRev: 0, repN: 0, repRev: 0 };
        a.buyRev += num(r.rev);
        if (m.result && d > m.result) { a.repN += num(r.n); a.repRev += num(r.rev); }
        agg.set(k, a);
      }
      for (const [k, a] of agg) {
        const i = idx.get(byKey.get(k)!.apply);
        buy.total.buy++; if (i != null) { buy.people[i]++; buy.rev[i] += a.buyRev; }
        if (a.repN >= 1) { buy.total.rep1++; if (i != null) { buy.rep1[i]++; buy.repRev[i] += a.repRev; } }
        if (a.repN >= 2) { buy.total.rep2++; if (i != null) buy.rep2[i]++; }
      }
    }
    out.buy = buy;
  } catch (e) { out.buy = fail(e); }
  return out;
}

// ── 결과 제출 폼(상품 주문형 주제 — 이유식 체험단) ── 날짜별 제출 건수와, 그 상품을 산 고객 가운데 결과를 낸 사람(처음 산 날 자리에).
//  제출한 사람의 전화번호 → 고객 키로 그 상품의 첫 구매일을 찾는다(custSection 의 '처음 산 날'과 같은 기준이라 처음 산 고객 수로 나눌 수 있다).
//  제출은 전체 기간을 받는다 — 결과를 낸 사람(미션 완료)의 재구매·재재구매를 전체 기간 합계(total)로 내려고. 제출 건수·설문·의견의 날짜 칸은 180일 안만.
async function submitSection(sb: SupabaseClient, def: TopicDef, days: string[], base: string): Promise<TopicSubmit> {
  const apiKey = await getTallyApiKey();
  if (!apiKey) throw new Error("탈리 API 키가 없습니다. VOC › 설정에서 탈리 API 키를 넣으세요.");
  const rs = await timeout(tallySubs(def.submit!.id, apiKey), 60_000, "탈리");
  const n = days.length, idx = new Map(days.map((x, i) => [x, i]));
  const out: TopicSubmit = { ok: true, count: zeros(n), done: zeros(n), rep1: zeros(n), rep2: zeros(n), repRev: zeros(n), total: { subs: 0, done: 0, rep1: 0, rep2: 0 },
    unmatched: 0, noPhone: 0, truncated: rs.truncated, survey: [], surveyAnswered: zeros(n), opinions: [] };
  // 설문 척도 문항 — 폼의 순서대로. 이름은 정의에 적어 둔 짧은 이름(없으면 문항 제목 그대로)
  const names = def.submit!.scaleNames || [];
  const scaleQ = new Map<string, TopicSubmit["survey"][number]>();
  if (def.submit!.scaleMax) for (const q of rs.questions) {
    if (!/SCALE|RATING/i.test(q.type || "")) continue;
    const title = (q.title || "").replace(/\s+/g, " ").trim();
    scaleQ.set(q.id, { label: names.find(([m]) => title.includes(m))?.[1] || title || "(제목 없음)", sum: zeros(n), n: zeros(n) });
  }
  const textQ = textQuestions(rs.questions, def.submit!.textNames);
  const byKey = new Map<string, number>();   // 고객 키 → 180일 안의 제출 건수(0 = 그보다 먼저 냈다)
  const shapes = new Map<string, number>(), byMonth = new Map<string, number>();   // 점검용 — 번호를 못 읽은 답의 모양, 달마다 제출 건수
  for (const s of rs.subs) {
    if (s.day > base) continue;   // 기준일 뒤(오늘) 제출은 다음 계산에
    out.total.subs++;
    byMonth.set(s.day.slice(0, 7), (byMonth.get(s.day.slice(0, 7)) || 0) + 1);
    if (!s.phone) shapes.set(s.shape, (shapes.get(s.shape) || 0) + 1);
    const i = idx.get(s.day);
    const k = s.phone ? customerKey(s.phone) : "";
    if (k) byKey.set(k, (byKey.get(k) || 0) + (i != null ? 1 : 0));
    if (i == null) continue;      // 180일보다 앞선 제출 — 전체 기간 합계에만 들어간다
    out.count[i]++;
    if (!k) out.noPhone++;
    let scoreSum = 0, scoreN = 0;
    for (const [qid, v] of s.scales) { const q = scaleQ.get(qid); if (q) { q.sum[i] += v; q.n[i]++; scoreSum += v; scoreN++; } }
    if (scoreN > 0) out.surveyAnswered[i]++;
    const parts = opinionParts(s, textQ);
    if (parts.length) out.opinions.push({ day: s.day, score: scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null, parts });
  }
  // 결과를 낸 사람의 첫 구매일과, 그 뒤 주제 밖 상품의 주문 수·매출(재구매 1번 이상, 재재구매 2번 이상)
  const keys = [...byKey.keys()], matched = new Set<string>(), other = otherSql(def);
  for (let c = 0; c < keys.length; c += KEY_CHUNK) {
    const rows = await runQ<{ k: string; d: string; n: number; rev: number }>(sb,
      `with t as (select o.customer_key, min(o.order_date) as first_t from sales_orders o `
      + `where o.customer_key in (${keys.slice(c, c + KEY_CHUNK).map(lit).join(", ")}) and o.order_date <= '${base}' and (${prodSql(def)}) group by 1) `
      + `select t.customer_key as k, t.first_t::text as d, (count(distinct o.order_unit) filter (where ${other}))::int as n, coalesce(sum(o.subtotal_amount) filter (where ${other}), 0)::bigint as rev `
      + `from t join sales_orders o on o.customer_key = t.customer_key where o.order_date <= '${base}' group by 1, 2`);
    for (const r of rows) {
      matched.add(String(r.k));
      const i = idx.get(String(r.d)), repN = num(r.n);   // 180일보다 먼저 산 고객은 전체 기간 합계에만
      out.total.done++; if (i != null) out.done[i]++;
      if (repN >= 1) { out.total.rep1++; if (i != null) { out.rep1[i]++; out.repRev[i] += num(r.rev); } }
      if (repN >= 2) { out.total.rep2++; if (i != null) out.rep2[i]++; }
    }
  }
  for (const [k, cnt] of byKey) if (!matched.has(k)) out.unmatched += cnt;   // 그 상품을 산 기록을 찾지 못한 제출
  out.survey = [...scaleQ.values()].filter((q) => sum(q.n) > 0);
  out.opinions = newestFirst(out.opinions);
  // 잇기 점검용(숫자만) — 제출 수·전화번호를 못 읽은 수·사람 수·구매를 찾은 사람 수. 제출률이 이상하면 이 줄부터 본다(Vercel 로그).
  console.info("[board-topic] submit", def.id, JSON.stringify({ subsAll: out.total.subs, subs180: sum(out.count), noPhone180: out.noPhone, people: keys.length, matched: matched.size, unmatched180: out.unmatched, done180: sum(out.done), doneAll: out.total.done, truncated: rs.truncated,
    byMonth: [...byMonth.entries()].sort(), noPhoneShapes: [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14), questions: rs.questions.map((q) => `${(q.type || "").slice(0, 18)}:${(q.title || "").replace(/\s+/g, " ").slice(0, 14)}`).slice(0, 30) }));
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
