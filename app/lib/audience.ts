// 오디언스 추출 — 조건으로 고객을 찾아 이름·전화번호를 엑셀로 내려받는다(메시지 발송은 사람이 따로 한다). 서버 전용.
//  고객 전화번호는 sales_customers 에만 있고 어떤 화면·AI 비서·루커에도 나오지 않는다. 이 기능이 번호를 밖으로 내보내는 유일한 길이라
//  검색과 추출을 모두 기록하고(activity_log audience.*) 화면에 그대로 보인다(2026-11-13 대표: "히스토리가 바로 보이게").
//
//  조회는 두 단계다:
//   ① 조건에 맞는 고객 키와 집계(주문 횟수·누적 금액·첫/마지막 구매일) — run_report(읽기 전용). 여기엔 전화번호가 없다.
//      안심번호(050)·번호 없는 고객은 sales_customer_summary(058) 에 없으므로 그 뷰에 있는 고객만 '보낼 수 있는 고객'으로 센다.
//   ② 그 고객 키로 sales_customers 에서 이름·번호를 읽는다 — 미리보기는 10명만 가려서, 추출은 전원.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSql } from "./analyst";

export type AudienceCond = {
  from?: string; to?: string;            // 구매 기간 — 이 기간에 산 고객
  channels?: string[];                   // 그 구매의 채널(여러 개 = 그중 하나)
  skus?: { sku: string; label: string }[]; // 그 구매의 상품 — 목록에서 고른 상품(상품코드 정확히 일치). label 은 기록에 보일 이름
  products?: string;                     // 그 구매의 상품 — 상품명·상품코드에 든 말, 쉼표로 여러 개. skus 와 합쳐 '그중 하나라도'
  minOrders?: number; maxOrders?: number; // 전체 기간 주문 횟수
  minAmount?: number;                    // 전체 기간 누적 구매 금액(원)
  lastFrom?: string; lastTo?: string;    // 마지막 구매일
};
export type AudienceRow = { customer_key: string; orders: number; amount: number; first_date: string; last_date: string };
export type AudienceFound = { rows: AudienceRow[]; excluded: number; capped: boolean };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;                       // SQL 문자열
const likeLit = (s: string) => lit(`%${s.replace(/[\\%_]/g, "\\$&")}%`);       // 포함 검색(와일드카드 무력화)
const posInt = (v: unknown): number | undefined => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };
export const MAX_AUDIENCE = 50_000; // 한 번에 다루는 고객 수 상한

// 화면에서 온 값을 다듬는다 — 형식이 틀린 값은 조건에서 뺀다(조건이 조용히 넓어지지 않게 호출부가 빈 조건을 막는다).
export function normalizeCond(raw: unknown): AudienceCond {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: AudienceCond = {};
  if (validDate(o.from)) c.from = o.from;
  if (validDate(o.to)) c.to = o.to;
  if (Array.isArray(o.channels)) { const ch = [...new Set(o.channels.map((x) => String(x).trim()).filter(Boolean))].slice(0, 30); if (ch.length) c.channels = ch; }
  if (Array.isArray(o.skus)) {
    const seen = new Set<string>();
    const skus: { sku: string; label: string }[] = [];
    for (const x of o.skus as { sku?: unknown; label?: unknown }[]) {
      const sku = String(x?.sku || "").trim().toUpperCase().slice(0, 64);
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      skus.push({ sku, label: String(x?.label || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) });
      if (skus.length >= 50) break;
    }
    if (skus.length) c.skus = skus;
  }
  const p = String(o.products || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20).join(", ");
  if (p) c.products = p;
  c.minOrders = posInt(o.minOrders); c.maxOrders = posInt(o.maxOrders); c.minAmount = posInt(o.minAmount);
  if (validDate(o.lastFrom)) c.lastFrom = o.lastFrom;
  if (validDate(o.lastTo)) c.lastTo = o.lastTo;
  for (const k of Object.keys(c) as (keyof AudienceCond)[]) if (c[k] === undefined) delete c[k];
  return c;
}
export const isEmptyCond = (c: AudienceCond): boolean => Object.keys(c).length === 0;

// 기록·화면에 남기는 조건 한 줄
export function condSummary(c: AudienceCond): string {
  const parts: string[] = [];
  if (c.from || c.to) parts.push(`구매 ${c.from || "처음"}~${c.to || "오늘"}`);
  if (c.channels?.length) parts.push(`채널 ${c.channels.join("/")}`);
  if (c.skus?.length) parts.push(`상품 ${c.skus.map((x) => (x.label ? `${x.label}(${x.sku})` : x.sku)).join(", ")}`);
  if (c.products) parts.push(`상품명·코드에 '${c.products}' 포함`);
  if (c.minOrders || c.maxOrders) parts.push(c.minOrders && c.maxOrders ? (c.minOrders === c.maxOrders ? `주문 ${c.minOrders}회` : `주문 ${c.minOrders}~${c.maxOrders}회`) : c.minOrders ? `주문 ${c.minOrders}회 이상` : `주문 ${c.maxOrders}회 이하`);
  if (c.minAmount) parts.push(`누적 ${c.minAmount.toLocaleString("ko-KR")}원 이상`);
  if (c.lastFrom || c.lastTo) parts.push(`마지막 구매 ${c.lastFrom || "처음"}~${c.lastTo || "오늘"}`);
  return parts.join(" · ") || "조건 없음";
}

// ① 조건에 맞는 고객 — 전화번호 없이 키와 집계만.
//  hit = 구매 기간·채널·상품에 맞는 주문이 하나라도 있는 고객. 주문 횟수·누적 금액·마지막 구매일은 그 고객의 전체 주문으로 센다.
export async function findAudience(sb: SupabaseClient, c: AudienceCond): Promise<AudienceFound> {
  const w: string[] = ["o.customer_key <> ''"];
  if (c.from) w.push(`o.order_date >= ${lit(c.from)}`);
  if (c.to) w.push(`o.order_date <= ${lit(c.to)}`);
  if (c.channels?.length) w.push(`o.channel in (${c.channels.map(lit).join(",")})`);
  // 상품 — 고른 상품(코드 정확히)과 포함어를 합쳐 '그중 하나라도 산 고객'
  const prod: string[] = [];
  if (c.skus?.length) prod.push(`upper(o.sku_code) in (${c.skus.map((x) => lit(x.sku.toUpperCase())).join(",")})`);
  if (c.products) for (const k of c.products.split(",").map((x) => x.trim()).filter(Boolean)) prod.push(`o.product_name ilike ${likeLit(k)} or o.option_name ilike ${likeLit(k)} or o.sku_code ilike ${likeLit(k)}`);
  if (prod.length) w.push(`(${prod.join(" or ")})`);
  const h: string[] = [];
  if (c.minOrders) h.push(`a.orders >= ${c.minOrders}`);
  if (c.maxOrders) h.push(`a.orders <= ${c.maxOrders}`);
  if (c.minAmount) h.push(`a.amount >= ${c.minAmount}`);
  if (c.lastFrom) h.push(`a.last_date >= ${lit(c.lastFrom)}`);
  if (c.lastTo) h.push(`a.last_date <= ${lit(c.lastTo)}`);
  const q = `
    with hit as (select distinct o.customer_key from sales_orders o where ${w.join(" and ")}),
    a as (
      select o.customer_key, count(distinct o.order_unit)::int as orders, coalesce(sum(o.subtotal_amount), 0)::bigint as amount,
             min(o.order_date)::text as first_date, max(o.order_date)::text as last_date
      from sales_orders o join hit using (customer_key) group by o.customer_key
    )
    select a.customer_key, a.orders, a.amount, a.first_date, a.last_date, (s.customer_key is not null) as reachable
    from a left join sales_customer_summary s on s.customer_key = a.customer_key
    ${h.length ? `where ${h.join(" and ")}` : ""}
    order by a.last_date desc, a.customer_key`;
  type R = AudienceRow & { reachable: boolean };
  const all = await runSql<R>(sb, q, MAX_AUDIENCE + 1);
  const capped = all.length > MAX_AUDIENCE;
  const list = capped ? all.slice(0, MAX_AUDIENCE) : all;
  const rows = list.filter((r) => r.reachable).map((r) => ({ customer_key: r.customer_key, orders: Number(r.orders) || 0, amount: Number(r.amount) || 0, first_date: r.first_date, last_date: r.last_date }));
  return { rows, excluded: list.length - rows.length, capped };
}

// ② 고객 키 → 이름·전화번호. 키 100개씩(주소 길이 한도), 8묶음씩 나란히.
export type Contact = { name: string; phone: string };
export async function loadContacts(sb: SupabaseClient, keys: string[]): Promise<Map<string, Contact>> {
  const out = new Map<string, Contact>();
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
  for (let i = 0; i < chunks.length; i += 8) {
    const res = await Promise.all(chunks.slice(i, i + 8).map((part) => sb.from("sales_customers").select("customer_key, phone, customer_name").in("customer_key", part)));
    for (const r of res) {
      if (r.error) throw new Error(`고객 연락처를 읽지 못했습니다: ${r.error.message}`);
      for (const x of (r.data ?? []) as { customer_key: string; phone: string; customer_name: string | null }[])
        out.set(x.customer_key, { name: (x.customer_name || "").trim(), phone: (x.phone || "").trim() });
    }
  }
  return out;
}

// 미리보기용 가리기 — 이름은 첫 글자만, 번호는 가운데를 가린다
export const maskName = (n: string): string => (n ? n[0] + "*".repeat(Math.max(1, Math.min(n.length - 1, 3))) : "-");
export const maskPhone = (p: string): string => { const d = p.replace(/\D/g, ""); return d.length >= 9 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : "-"; };

// 상품 선택지 — 주문에 나온 상품코드마다 한 줄(주문 많은 순). 이름은 상품 마스터(products) 것, 없으면 주문에 적힌 상품명.
//  화면이 이름·코드·주문 상품명으로 찾아 고른다. 코드 없는 주문은 여기 없다 — 그런 상품은 포함어로 찾는다.
export type ProductOption = { sku: string; name: string; listing: string; orders: number };
export async function listProducts(sb: SupabaseClient): Promise<ProductOption[]> {
  const rows = await runSql<{ sku: string; name: string | null; spec: string | null; listing: string | null; orders: number }>(sb, `
    select upper(o.sku_code) as sku, max(p.name) as name, max(p.spec) as spec, max(o.product_name) as listing, count(distinct o.order_unit)::int as orders
    from sales_orders o left join products p on upper(p.sku) = upper(o.sku_code)
    where o.sku_code <> '' group by upper(o.sku_code) order by orders desc`, 3000);
  return rows.map((r) => ({ sku: r.sku, name: [r.name, r.spec].filter(Boolean).join(" · ") || (r.listing || r.sku), listing: r.listing || "", orders: Number(r.orders) || 0 }));
}

// 채널 선택지 — 주문이 있는 채널(많은 순)
export async function listChannels(sb: SupabaseClient): Promise<string[]> {
  const rows = await runSql<{ channel: string }>(sb, `select channel, count(*) n from sales_orders where channel <> '' group by channel order by n desc`, 100);
  return rows.map((r) => r.channel);
}
