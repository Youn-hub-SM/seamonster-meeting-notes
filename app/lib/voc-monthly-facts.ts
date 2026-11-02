// 월간 VOC 리포트 — 판매·배송 대비 VOC율 집계(159, 2026-11-02 대표 결정 — 기획안 docs/voc-monthly-report-plan.md).
//  숫자는 전부 여기서 계산하고(facts), AI(Fable)는 이 숫자 안에서만 글을 쓴다. 화면·Word 의 KPI 띠·차트도 이 facts 로 그린다.
//
//  연결 키
//   · 어종(품목 계열) = SKU 어종 코드(대표 결정 1): TD_·P_·P-·R-·BULK- 접두를 벗긴 첫 글자 묶음(DSC 삼치·CD 참돔·GA 광어·AG 아귀·NA 농어·
//     DG 대구·YA 연어·SH 새우·T 틸라피아). 세트는 product_bundles 로 구성품까지 전개(11팩 세트 1개 = 삼치 11팩), 구성품 미등록 세트
//     (예 P-R-YA.DSC)는 '.' 으로 나뉜 어종 모두에 1씩.
//   · VOC 구매상품(voc.product, 상품마스터 이름) → products.sku → 어종. 이름이 마스터에 없으면 주문번호(148)의 매출 행으로, 그래도 없으면 '미매칭'.
//   · 채널 = voc.purchase_place 를 별칭표로 매출 채널명에 맞춘다. 도매 업체명이면 '도매'(대표 결정 2: 별도로 있으면 기재).
//   · 분모 = sales_orders(159 함수: 월·채널·관리코드 판매 수량 / 월·채널 배송 건수 order_unit). 도매 분모 = inventory_txns 'B2B 자동출고' 출고.
//  율 = 건수 ÷ 분모 × 1,000. 최소 판매 수량 기준 없음(대표 결정 6) — 소량 품목도 율 그대로.
//  폴백: 159 함수가 없거나 그 달 원장이 없으면 율을 null(화면은 숨김·건수만) + notes 에 사유. 설문·문의는 별개 표라 각각 실패해도 나머지는 낸다.
//  개인정보: 고객 이름·연락처·주문번호는 facts 에 넣지 않는다(집계·상품명·채널명만).
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "./sales-paging";
import { MFG_FAULT } from "./voc-manufacturer";
import { maxOrderDate } from "./sales-report";

export const TREND_MONTHS = 6;                   // 대표 결정 3
const B2B_SHIP_BY = "B2B 자동출고";              // app/lib/b2b-shipments.ts B2B_SHIP_BY 와 같은 값(순환 import 피함)
const NAVER = "스마트스토어";                    // channel_inquiries.channel

// SKU 어종 코드 → 이름 — 셰어포인트 '상품 등록 › 상품코드(sku code) 생성 규칙' 2절 그대로(2026-11-02 대표: DAL 달고기 등 누락 보완).
//  표에 없는 코드(부자재 STEAMER 등)는 어종 집계에서 뺀다 — VOC 가 그 코드에 걸리면 코드 글자 그대로 보인다.
export const FISH_NAMES: Record<string, string> = {
  AG: "아귀", CD: "참돔", DG: "대구", DSC: "삼치", GA: "광어", NA: "농어", YA: "연어", T: "틸라피아", SQ: "오징어", SH: "새우", DAL: "달고기",
};
// VOC 구매처 표기 → 매출 채널명(sales_orders.channel). 키는 공백 제거·소문자.
const CHANNEL_ALIAS: Record<string, string> = {
  "카페24": "카페24", "공식몰": "카페24", "자사몰": "카페24", "홈페이지": "카페24", "씨몬스터": "카페24", "공식홈페이지": "카페24",
  "스마트스토어": "스마트스토어", "네이버": "스마트스토어", "네이버스마트스토어": "스마트스토어", "스토어": "스마트스토어", "네이버쇼핑": "스마트스토어",
  "쿠팡": "쿠팡", "로켓": "쿠팡",
  "톡스토어": "톡스토어", "카카오": "톡스토어", "카카오톡스토어": "톡스토어", "톡딜": "톡스토어",
};
export const WHOLESALE = "도매";

export type FactsTrend = { ym: string; voc: number; mfg: number; sold_qty: number | null; parcels: number | null; rate_qty: number | null; rate_parcel: number | null };
export type FactsSpecies = { code: string; name: string; voc: number; mfg: number; loss: number; sold_qty: number | null; rate: number | null; prev_rate: number | null; top_category: string | null; categories: [string, number][] };
export type FactsChannel = { channel: string; voc: number; parcels: number | null; sold_qty: number | null; rate: number | null; prev_rate: number | null; top_category: string | null };
export type VocMonthlyFacts = {
  month: string;
  generated_at: string;
  sales_as_of: string | null;                     // 매출 원장 반영 마지막 날(이 날 뒤 원장이 없으면 율이 높게 보인다)
  notes: string[];                                // 폴백·제외 사유(리포트가 그대로 밝힌다)
  summary: {
    voc_total: number; voc_mfg: number; loss_total: number;
    sold_qty: number | null; parcels: number | null; rate_qty: number | null; rate_parcel: number | null;
    prev: { ym: string; voc_total: number; voc_mfg: number; loss_total: number; sold_qty: number | null; parcels: number | null; rate_qty: number | null; rate_parcel: number | null };
    yoy: { ym: string; voc_total: number; sold_qty: number | null; rate_qty: number | null } | null;
    surveys: number;
  };
  trend: FactsTrend[];                            // 오래된 달 → 이번 달(6개월)
  by_category_trend: { ym: string; counts: Record<string, number> }[];
  by_category: { category: string; count: number; prev: number; loss: number }[];
  by_fault: { fault: string; count: number; loss: number }[];
  by_species: FactsSpecies[];                     // 율 내림차순(율 없으면 뒤)
  by_channel: FactsChannel[];
  wholesale: { voc: number; shipments: number | null; sold_qty: number | null; rate_qty: number | null } | null; // 도매 VOC 가 있을 때만
  buyer: { voc_repeat_share: number | null; customers_repeat_share: number | null }; // VOC 중 재구매 비중 vs 그 달 구매 고객 중 재구매 비중(%)
  inquiries: { ok: boolean; note?: string; total: number; unanswered: number; avg_answer_h: number | null; naver_parcels: number | null; rate_parcel: number | null; by_kind: Record<string, number>; prev_total: number | null };
  unmatched: { products: [string, number][]; places: [string, number][] };
};

// ── 날짜 ──
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); return ymOf(new Date(y, m - 1 + n, 1)); };
const monthStart = (ym: string) => `${ym}-01`;
const monthEnd = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const kstMonthStart = (ym: string) => `${ym}-01T00:00:00+09:00`;
const r1 = (n: number) => Math.round(n * 10) / 10;
const per1k = (n: number, d: number | null) => (d && d > 0 ? r1((n / d) * 1000) : null);
const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, "").toLowerCase();

// ── 어종 코드 ──
export function fishCodesOf(sku: string | null | undefined): string[] {
  let s = (sku || "").trim().toUpperCase();
  if (!s) return [];
  for (;;) { const t = s.replace(/^(TD_|P_|P-|R-|BULK-)/, ""); if (t === s) break; s = t; }
  const out: string[] = [];
  for (const tok of s.split(".")) {
    const m = tok.match(/^[A-Z]+/);
    if (m && FISH_NAMES[m[0]] && !out.includes(m[0])) out.push(m[0]); // 어종 코드표에 있는 것만(부자재 STEAMER 등 제외)
  }
  return out;
}
export const fishName = (code: string) => FISH_NAMES[code] || code;

type ProductRow = { id: string; sku: string | null; name: string };
type BundleRow = { parent_id: string; component_id: string; qty: number };

// 상품 → 어종별 배수(세트는 구성품 전개, 중첩 8단). 세트 아니면 어종 코드마다 1.
function makeFishResolver(products: ProductRow[], bundles: BundleRow[]) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const bySku = new Map<string, ProductRow>();
  for (const p of products) if (p.sku) bySku.set(p.sku.trim().toUpperCase(), p);
  const byName = new Map<string, ProductRow>();
  for (const p of products) byName.set(norm(p.name), p);
  const comps = new Map<string, BundleRow[]>();
  for (const b of bundles) { const a = comps.get(b.parent_id) || []; a.push(b); comps.set(b.parent_id, a); }
  const cache = new Map<string, Map<string, number>>();
  const ofProduct = (id: string, depth = 0): Map<string, number> => {
    const hit = cache.get(id); if (hit) return hit;
    const out = new Map<string, number>();
    const cs = comps.get(id);
    if (cs && cs.length && depth < 8) {
      for (const c of cs) for (const [f, k] of ofProduct(c.component_id, depth + 1)) out.set(f, (out.get(f) || 0) + k * (Number(c.qty) || 1));
    } else {
      for (const f of fishCodesOf(byId.get(id)?.sku)) out.set(f, 1);
    }
    cache.set(id, out);
    return out;
  };
  // 매출 관리코드 → 어종 배수. 정확 일치 → TD_ 뗀 코드(158 과 같은 규칙) → 마스터에 없으면 코드 글자에서 어종만.
  const ofSalesSku = (code: string): Map<string, number> => {
    const u = (code || "").trim().toUpperCase();
    const p = bySku.get(u) || (u.startsWith("TD_") ? bySku.get(u.slice(3)) : undefined);
    if (p) return ofProduct(p.id);
    const m = new Map<string, number>();
    for (const f of fishCodesOf(u)) m.set(f, 1);
    return m;
  };
  const ofName = (name: string | null | undefined): Map<string, number> | null => {
    const p = byName.get(norm(name));
    return p ? ofProduct(p.id) : null;
  };
  return { ofProduct, ofSalesSku, ofName, bySku };
}

// ── 채널 ──
function canonChannel(place: string | null | undefined, salesChannels: Set<string>, companyNames: Set<string>): string | null {
  const raw = (place || "").trim();
  if (!raw) return null;
  const k = norm(raw);
  if (companyNames.has(k) || /도매|b2b|납품|거래처/.test(k)) return WHOLESALE;
  const alias = CHANNEL_ALIAS[k] || CHANNEL_ALIAS[k.replace(/점$/, "")];
  if (alias) return alias;
  for (const ch of salesChannels) if (norm(ch) === k) return ch;
  for (const ch of salesChannels) if (k.includes(norm(ch)) || norm(ch).includes(k)) return ch;
  return null;
}

// ── 조회 ──
type VocRow = { id: string; received_at: string; product: string | null; purchase_place: string | null; order_no: string | null; category: string | null; fault: string | null; loss_amount: number | string | null; buyer_type: string | null };
type SkuAgg = { ym: string; channel: string; sku_code: string; qty: number | string };
type ParcelAgg = { ym: string; channel: string; parcels: number | string; qty: number | string };
const missingFn = (e: unknown, name: string) => {
  const m = String((e as { message?: string } | null)?.message || e), code = (e as { code?: string } | null)?.code;
  return code === "PGRST202" || code === "42883" || (new RegExp(name, "i").test(m) && /could not find|does not exist|schema cache/i.test(m));
};
const missingCol = (e: unknown, col: string) => new RegExp(`\\b${col}\\b`, "i").test(String((e as { message?: string } | null)?.message || "")) && /column|schema cache|does not exist/i.test(String((e as { message?: string } | null)?.message || ""));

// 용도(2026-11-02 대표): 제조사용은 제조·품질·포장에 관한 유형만, 내부용은 전체.
export type VocAudience = "제조사" | "내부";
export const MFG_CATEGORIES = ["품질", "가시", "이물", "포장"] as const;
export const audienceOf = (v: unknown): VocAudience => (v === "내부" ? "내부" : "제조사");
export const categoriesFor = (a: VocAudience): readonly string[] | null => (a === "제조사" ? MFG_CATEGORIES : null); // null = 전체

export async function buildVocMonthlyFacts(sb: SupabaseClient, month: string, opts: { categories?: readonly string[] | null } = {}): Promise<VocMonthlyFacts> {
  const notes: string[] = [];
  const catFilter = opts.categories && opts.categories.length ? new Set(opts.categories) : null;
  const inScope = (r: { category: string | null }) => !catFilter || catFilter.has((r.category || "").trim());
  if (catFilter) notes.push(`집계 범위: ${[...catFilter].join("·")} 유형만(제조·품질·포장 관련). 배송·누락·오배송 등은 내부용 리포트에서 봅니다`);
  const months = Array.from({ length: TREND_MONTHS }, (_, i) => addMonths(month, i - (TREND_MONTHS - 1))); // 오래된 → 이번 달
  const prevYm = addMonths(month, -1);
  const yoyYm = addMonths(month, -12);
  const from = monthStart(months[0]), to = monthEnd(month);
  const yoyFrom = monthStart(yoyYm), yoyTo = monthEnd(yoyYm);

  // 1) VOC(설문 제외) — 추이 6개월 + 전년 같은 달
  const VOC_SEL = "id, received_at, product, purchase_place, order_no, category, fault, loss_amount, buyer_type";
  const readVoc = (a: string, b: string, label: string) => fetchAllPages<VocRow>((lo, hi) => sb.from("voc").select(VOC_SEL)
    .neq("source", "설문").gte("received_at", a).lte("received_at", b).order("received_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi), { cap: 20000, label });
  const [vocAllRaw, vocYoyRaw, products, bundles] = await Promise.all([
    readVoc(from, to, "VOC"),
    readVoc(yoyFrom, yoyTo, "VOC(전년)"),
    fetchAllPages<ProductRow>((lo, hi) => sb.from("products").select("id, sku, name").order("id", { ascending: true }).range(lo, hi), { cap: 20000, label: "상품마스터" }),
    fetchAllPages<BundleRow>((lo, hi) => sb.from("product_bundles").select("parent_id, component_id, qty").order("parent_id", { ascending: true }).order("component_id", { ascending: true }).range(lo, hi), { cap: 20000, label: "묶음" })
      .catch(() => [] as BundleRow[]), // 037 미적용이면 세트 전개 없이
  ]);
  const vocAll = vocAllRaw.filter(inScope), vocYoy = vocYoyRaw.filter(inScope);
  const fish = makeFishResolver(products, bundles);

  // 2) 매출 분모(159 함수) — 없으면 율 없이
  let skuAgg: SkuAgg[] | null = null, parcelAgg: ParcelAgg[] | null = null;
  try {
    const readAgg = <R,>(fn: string, a: string, b: string) => fetchAllPages<R>((lo, hi) => sb.rpc(fn, { p_from: a, p_to: b }).range(lo, hi), { cap: 100000, label: fn });
    const [s1, s2, p1, p2] = await Promise.all([
      readAgg<SkuAgg>("voc_sales_by_sku", from, to), readAgg<SkuAgg>("voc_sales_by_sku", yoyFrom, yoyTo),
      readAgg<ParcelAgg>("voc_sales_parcels", from, to), readAgg<ParcelAgg>("voc_sales_parcels", yoyFrom, yoyTo),
    ]);
    skuAgg = [...s1, ...s2]; parcelAgg = [...p1, ...p2];
  } catch (e) {
    notes.push(missingFn(e, "voc_sales") ? "매출 집계 함수(159) 미적용 — 판매·배송 대비 율 없이 건수만" : `매출 집계 실패(${String((e as { message?: string }).message || e).slice(0, 80)}) — 율 없이 건수만`);
  }
  const salesChannels = new Set<string>((parcelAgg || []).map((r) => r.channel).filter(Boolean));
  const salesAsOf = await maxOrderDate().catch(() => null);

  // 3) 도매 출고(B2B 자동출고) — 어종별·건수
  type TxnRow = { product_id: string; qty: number | string; txn_date: string; shipment_id: string | null; group_id: string | null; status: string | null };
  let b2bTx: TxnRow[] = [];
  try {
    b2bTx = await fetchAllPages<TxnRow>((lo, hi) => sb.from("inventory_txns").select("product_id, qty, txn_date, shipment_id, group_id, status")
      .eq("created_by", B2B_SHIP_BY).eq("type", "출고").gte("txn_date", from).lte("txn_date", to).order("id", { ascending: true }).range(lo, hi), { cap: 50000, label: "B2B 출고" });
    b2bTx = b2bTx.filter((t) => t.status == null || t.status === "완료");
  } catch { notes.push("도매 출고(B2B) 집계 실패 — 도매 분모 없음"); }
  let companyNames = new Set<string>();
  try { const { data } = await sb.from("companies").select("name").limit(2000); companyNames = new Set((data || []).map((c: { name: string }) => norm(c.name)).filter(Boolean)); } catch { /* 이름 대조만 생략 */ }

  // 4) VOC 한 건 → (월, 어종 배수, 채널)
  const curVoc = vocAll.filter((r) => r.received_at.slice(0, 7) === month);
  // 주문번호 폴백(이름이 마스터에 없을 때만) — 이번 달 건만, 100개씩
  const needOrder = curVoc.filter((r) => r.order_no && !fish.ofName(r.product));
  const orderFish = new Map<string, { fish: Map<string, number>; channel: string }>();
  if (needOrder.length) {
    const keys = [...new Set(needOrder.map((r) => String(r.order_no).trim()))];
    for (let i = 0; i < keys.length; i += 100) {
      const { data } = await sb.from("sales_orders").select("order_id, sku_code, channel").in("order_id", keys.slice(i, i + 100)).limit(2000);
      for (const o of (data || []) as { order_id: string; sku_code: string; channel: string }[]) {
        const cur = orderFish.get(o.order_id) || { fish: new Map<string, number>(), channel: o.channel };
        for (const [f] of fish.ofSalesSku(o.sku_code)) cur.fish.set(f, 1);
        orderFish.set(o.order_id, cur);
      }
    }
  }
  const unmatchedProducts = new Map<string, number>(), unmatchedPlaces = new Map<string, number>();
  type Tagged = VocRow & { ym: string; fishes: string[]; channel: string | null; mfg: boolean; loss: number };
  const tag = (r: VocRow, countUnmatched: boolean): Tagged => {
    let fm = fish.ofName(r.product);
    let channel = canonChannel(r.purchase_place, salesChannels, companyNames);
    if (!fm && r.order_no) {
      const o = orderFish.get(String(r.order_no).trim());
      if (o && o.fish.size === 1) { fm = o.fish; if (!channel) channel = o.channel; }
    }
    const fishes = fm ? [...fm.keys()] : [];
    if (countUnmatched) {
      if (!fishes.length) { const k = (r.product || "").trim() || "(상품 없음)"; unmatchedProducts.set(k, (unmatchedProducts.get(k) || 0) + 1); }
      if (!channel) { const k = (r.purchase_place || "").trim() || "(구매처 없음)"; unmatchedPlaces.set(k, (unmatchedPlaces.get(k) || 0) + 1); }
    }
    return { ...r, ym: r.received_at.slice(0, 7), fishes, channel, mfg: r.fault === MFG_FAULT, loss: Number(r.loss_amount) || 0 };
  };
  const tagged = vocAll.map((r) => tag(r, r.received_at.slice(0, 7) === month));
  const taggedYoy = vocYoy.map((r) => tag(r, false));
  const inMonth = (ym: string) => tagged.filter((r) => r.ym === ym);

  // 5) 분모 — 월별 전체·어종별·채널별
  const soldByMonth = new Map<string, number>(), parcelsByMonth = new Map<string, number>();
  const soldByMonthFish = new Map<string, Map<string, number>>(), parcelsByMonthChannel = new Map<string, Map<string, number>>(), soldByMonthChannel = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, ym: string, k: string, v: number) => { const inner = m.get(ym) || new Map<string, number>(); inner.set(k, (inner.get(k) || 0) + v); m.set(ym, inner); };
  if (skuAgg && parcelAgg) {
    for (const r of parcelAgg) {
      parcelsByMonth.set(r.ym, (parcelsByMonth.get(r.ym) || 0) + Number(r.parcels));
      soldByMonth.set(r.ym, (soldByMonth.get(r.ym) || 0) + Number(r.qty));
      bump(parcelsByMonthChannel, r.ym, r.channel, Number(r.parcels));
      bump(soldByMonthChannel, r.ym, r.channel, Number(r.qty));
    }
    for (const r of skuAgg) for (const [f, k] of fish.ofSalesSku(r.sku_code)) bump(soldByMonthFish, r.ym, f, Number(r.qty) * k);
  }
  const hasSales = (ym: string) => (skuAgg && parcelAgg ? (soldByMonth.get(ym) || 0) > 0 : false);
  if (skuAgg && !hasSales(month)) notes.push(`${month} 매출 원장이 없어 이번 달 율을 낼 수 없습니다(매출 업로드 뒤 다시 생성)`);

  // 도매 분모(이번 달)
  const b2bCur = b2bTx.filter((t) => t.txn_date.slice(0, 7) === month);
  const b2bQty = b2bCur.reduce((s, t) => s + Math.abs(Number(t.qty) || 0), 0);
  const b2bShipments = new Set(b2bCur.map((t) => t.shipment_id || t.group_id || t.txn_date)).size;

  // 6) 추이·요약
  const sumOf = (ym: string, rows: Tagged[]) => {
    const voc = rows.length, mfg = rows.filter((r) => r.mfg).length, loss = rows.reduce((s, r) => s + r.loss, 0);
    const sold = hasSales(ym) ? soldByMonth.get(ym) || 0 : null, parcels = hasSales(ym) ? parcelsByMonth.get(ym) || 0 : null;
    return { ym, voc_total: voc, voc_mfg: mfg, loss_total: loss, sold_qty: sold, parcels, rate_qty: per1k(voc, sold), rate_parcel: per1k(voc, parcels) };
  };
  const trend: FactsTrend[] = months.map((ym) => { const s = sumOf(ym, inMonth(ym)); return { ym, voc: s.voc_total, mfg: s.voc_mfg, sold_qty: s.sold_qty, parcels: s.parcels, rate_qty: s.rate_qty, rate_parcel: s.rate_parcel }; });
  const cur = sumOf(month, inMonth(month));
  const prev = sumOf(prevYm, inMonth(prevYm));
  const yoyRows = taggedYoy;
  const yoySold = skuAgg && (soldByMonth.get(yoyYm) || 0) > 0 ? soldByMonth.get(yoyYm) || 0 : null;
  const yoy = yoyRows.length || yoySold ? { ym: yoyYm, voc_total: yoyRows.length, sold_qty: yoySold, rate_qty: per1k(yoyRows.length, yoySold) } : null;

  // 유형
  const CATS = ["배송", "품질", "포장", "누락", "오배송", "가시", "이물", "기타"];
  const catOf = (r: Tagged) => (r.category || "").trim() || "기타";
  const by_category_trend = months.map((ym) => { const counts: Record<string, number> = {}; for (const c of CATS) counts[c] = 0; for (const r of inMonth(ym)) counts[catOf(r)] = (counts[catOf(r)] || 0) + 1; return { ym, counts }; });
  const curRows = inMonth(month), prevRows = inMonth(prevYm);
  const by_category = [...new Set([...CATS, ...curRows.map(catOf), ...prevRows.map(catOf)])]
    .map((category) => ({ category, count: curRows.filter((r) => catOf(r) === category).length, prev: prevRows.filter((r) => catOf(r) === category).length, loss: curRows.filter((r) => catOf(r) === category).reduce((s, r) => s + r.loss, 0) }))
    .filter((c) => c.count || c.prev).sort((a, b) => b.count - a.count);
  const by_fault = [...new Set(curRows.map((r) => (r.fault || "미분류").trim() || "미분류"))]
    .map((fault) => ({ fault, count: curRows.filter((r) => ((r.fault || "미분류").trim() || "미분류") === fault).length, loss: curRows.filter((r) => ((r.fault || "미분류").trim() || "미분류") === fault).reduce((s, r) => s + r.loss, 0) }))
    .sort((a, b) => b.count - a.count);

  // 어종별 — 이번 달 VOC 가 있는 어종만(대표 2026-11-02: 모든 어종을 늘어놓지 않는다). 분모(판매 수량)는 그 어종의 매출로.
  const topCat = (rows: Tagged[]): { top: string | null; cats: [string, number][] } => {
    const m = new Map<string, number>(); for (const r of rows) m.set(catOf(r), (m.get(catOf(r)) || 0) + 1);
    const cats = [...m.entries()].sort((a, b) => b[1] - a[1]); return { top: cats[0]?.[0] ?? null, cats };
  };
  const speciesCodes = new Set<string>(curRows.flatMap((r) => r.fishes));
  const by_species: FactsSpecies[] = [...speciesCodes].map((code) => {
    const rows = curRows.filter((r) => r.fishes.includes(code)), prow = prevRows.filter((r) => r.fishes.includes(code));
    const sold = hasSales(month) ? soldByMonthFish.get(month)?.get(code) || 0 : null;
    const psold = hasSales(prevYm) ? soldByMonthFish.get(prevYm)?.get(code) || 0 : null;
    const tc = topCat(rows);
    return { code, name: fishName(code), voc: rows.length, mfg: rows.filter((r) => r.mfg).length, loss: rows.reduce((s, r) => s + r.loss, 0), sold_qty: sold, rate: per1k(rows.length, sold), prev_rate: per1k(prow.length, psold), top_category: tc.top, categories: tc.cats };
  }).filter((s) => s.voc > 0)
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.voc - a.voc || (b.sold_qty ?? 0) - (a.sold_qty ?? 0));

  // 채널별(소매 채널 + 도매는 따로)
  const channelCodes = new Set<string>([...salesChannels, ...curRows.map((r) => r.channel).filter((c): c is string => !!c && c !== WHOLESALE)]);
  const by_channel: FactsChannel[] = [...channelCodes].map((channel) => {
    const rows = curRows.filter((r) => r.channel === channel), prow = prevRows.filter((r) => r.channel === channel);
    const parcels = hasSales(month) ? parcelsByMonthChannel.get(month)?.get(channel) || 0 : null;
    const sold = hasSales(month) ? soldByMonthChannel.get(month)?.get(channel) || 0 : null;
    const pparcels = hasSales(prevYm) ? parcelsByMonthChannel.get(prevYm)?.get(channel) || 0 : null;
    return { channel, voc: rows.length, parcels, sold_qty: sold, rate: per1k(rows.length, parcels), prev_rate: per1k(prow.length, pparcels), top_category: topCat(rows).top };
  }).filter((c) => c.voc || (c.parcels || 0) > 0)
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.voc - a.voc);
  const wholesaleVoc = curRows.filter((r) => r.channel === WHOLESALE);
  const wholesale = wholesaleVoc.length
    ? { voc: wholesaleVoc.length, shipments: b2bShipments || null, sold_qty: b2bQty || null, rate_qty: per1k(wholesaleVoc.length, b2bQty || null) }
    : null;

  // 7) 첫/재구매 — VOC 중 재구매 비중 vs 그 달 구매 고객 중 재구매 비중
  const typed = curRows.filter((r) => r.buyer_type === "첫구매" || r.buyer_type === "재구매");
  const voc_repeat_share = typed.length ? r1((typed.filter((r) => r.buyer_type === "재구매").length / typed.length) * 100) : null;
  let customers_repeat_share: number | null = null;
  try {
    const { data } = await sb.rpc("sales_new_repeat", { p_from: monthStart(month), p_to: to });
    const row = Array.isArray(data) ? data[0] : data;
    if (row && Number(row.total) > 0) customers_repeat_share = r1((Number(row.repeat_cust) / Number(row.total)) * 100);
  } catch { /* 비교 생략 */ }

  // 8) 스마트스토어 문의(137)
  let inquiries: VocMonthlyFacts["inquiries"] = { ok: false, note: "수집 전(137 미적용)", total: 0, unanswered: 0, avg_answer_h: null, naver_parcels: null, rate_parcel: null, by_kind: {}, prev_total: null };
  try {
    type Inq = { kind: string; answered: boolean | null; asked_at: string | null; answered_at: string | null };
    const readInq = (ym: string) => fetchAllPages<Inq>((lo, hi) => sb.from("channel_inquiries").select("id, kind, answered, asked_at, answered_at").eq("channel", NAVER)
      .gte("asked_at", kstMonthStart(ym)).lt("asked_at", kstMonthStart(addMonths(ym, 1))).order("asked_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi), { cap: 20000, label: "문의" });
    const [ci, pi] = await Promise.all([readInq(month), readInq(prevYm)]);
    const delays = ci.map((r) => (r.answered && r.asked_at && r.answered_at ? (Date.parse(r.answered_at) - Date.parse(r.asked_at)) / 3600e3 : null)).filter((h): h is number => h != null && h >= 0);
    const by_kind: Record<string, number> = {}; for (const r of ci) by_kind[r.kind] = (by_kind[r.kind] || 0) + 1;
    const naverParcels = hasSales(month) ? parcelsByMonthChannel.get(month)?.get(NAVER) || 0 : null;
    inquiries = { ok: true, total: ci.length, unanswered: ci.filter((r) => !r.answered).length, avg_answer_h: delays.length ? r1(delays.reduce((s, h) => s + h, 0) / delays.length) : null,
      naver_parcels: naverParcels, rate_parcel: per1k(ci.length, naverParcels), by_kind, prev_total: pi.length };
  } catch (e) { inquiries.note = missingFn(e, "channel_inquiries") ? "수집 전(137 미적용)" : `문의 집계 실패: ${String((e as { message?: string }).message || e).slice(0, 80)}`; }

  // 9) 설문 건수(그 달)
  let surveys = 0;
  try {
    const { data } = await sb.from("survey_responses").select("submitted_at, created_at").limit(5000);
    surveys = (data || []).filter((r: { submitted_at?: string | null; created_at?: string | null }) => String(r.submitted_at || r.created_at || "").slice(0, 7) === month).length;
  } catch { /* 설문 표 없음 */ }

  if (unmatchedProducts.size) notes.push(`구매상품이 상품마스터와 맞지 않아 어종 집계에서 뺀 접수 ${[...unmatchedProducts.values()].reduce((a, b) => a + b, 0)}건`);
  if (unmatchedPlaces.size) notes.push(`구매처를 매출 채널로 맞추지 못해 채널 집계에서 뺀 접수 ${[...unmatchedPlaces.values()].reduce((a, b) => a + b, 0)}건`);

  return {
    month, generated_at: new Date().toISOString(), sales_as_of: salesAsOf, notes,
    summary: { voc_total: cur.voc_total, voc_mfg: cur.voc_mfg, loss_total: cur.loss_total, sold_qty: cur.sold_qty, parcels: cur.parcels, rate_qty: cur.rate_qty, rate_parcel: cur.rate_parcel, prev, yoy, surveys },
    trend, by_category_trend, by_category, by_fault, by_species, by_channel, wholesale,
    buyer: { voc_repeat_share, customers_repeat_share },
    inquiries,
    unmatched: { products: [...unmatchedProducts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20), places: [...unmatchedPlaces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20) },
  };
}

// 저장 폴백 — 159 미적용(facts 칸 없음)이면 그 칸만 빼고 다시 저장할 때 쓰는 판정
export const factsColMissing = (e: unknown) => missingCol(e, "facts") || missingCol(e, "generated_at");
