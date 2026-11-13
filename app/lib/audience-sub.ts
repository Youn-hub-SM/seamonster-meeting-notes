// 오디언스 추출 — 정기배송 고객(2026-11-13 대표: 일시정지 중·일시정지 오래됨·최근 해지·n회차 이상·결제 예정일·특정 상품). 서버 전용.
//  정기배송 상태는 매일 23:59 중계 서버가 카페24에서 가져와 쌓는다(migration 127 cafe24_subscriptions·items·payments, 129 상태 변화 기록).
//  거기엔 이름·전화번호가 없다(일부러 저장하지 않음). 전화번호는 이렇게 잇는다:
//    정기배송 신청 → 회차별 결제 주문번호(cafe24_subscription_payments.order_id) → 매출 주문(sales_orders.order_id) → 고객 키 → sales_customers
//  (주문번호 형식이 양쪽 같다 — 매출 리포트의 정기배송 매출이 같은 조인을 쓴다, 2026-10-19 확인.)
//  결제 주문이 매출 원장에 없는 신청은 번호를 못 찾는다 — 몇 건인지 결과에 함께 돌려준다.
//
//  한 고객이 신청을 여러 개 가질 수 있어 결과는 고객 단위로 묶는다(상태·상품은 이어 적고, 회차는 큰 값, 결제 예정일은 빠른 날).
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSql } from "./analyst";
import { loadContacts, MAX_AUDIENCE, type Contact } from "./audience";

export const SUB_STATES = ["U", "P", "C"] as const;
export type SubState = (typeof SUB_STATES)[number];
export const SUB_STATE_LABEL: Record<SubState, string> = { U: "이용중", P: "일시정지", C: "해지" };

export type SubCond = {
  mode: "sub";
  states?: SubState[];                 // 지금 상태(여러 개 = 그중 하나)
  changedFrom?: string; changedTo?: string; // 지금 상태가 된 날 — 일시정지한 날·해지한 날·재개한 날
  minRound?: number; maxRound?: number;     // 회차(신청 품목 중 가장 큰 회차)
  payFrom?: string; payTo?: string;         // 다음 결제 예정일(이용중 품목 중 가장 빠른 날)
  products?: string[];                 // 정기배송 상품명(정확히 일치, 여러 개 = 그중 하나)
};
// 고객 한 명(신청 여러 개면 묶음)
export type SubRow = { customer_key: string; states: string; round: number | null; next_pay: string | null; changed_on: string | null; items: string; codes: string; sub_ids: string; subs: number };
export type SubFound = { rows: SubRow[]; subs: number; unlinked: number; capped: boolean; noLog: boolean };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const posInt = (v: unknown): number | undefined => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };

export const isSubCond = (raw: unknown): boolean => !!raw && typeof raw === "object" && (raw as { mode?: unknown }).mode === "sub";

export function normalizeSubCond(raw: unknown): SubCond {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: SubCond = { mode: "sub" };
  if (Array.isArray(o.states)) { const st = SUB_STATES.filter((s) => (o.states as unknown[]).includes(s)); if (st.length) c.states = st; }
  if (validDate(o.changedFrom)) c.changedFrom = o.changedFrom;
  if (validDate(o.changedTo)) c.changedTo = o.changedTo;
  c.minRound = posInt(o.minRound); c.maxRound = posInt(o.maxRound);
  if (validDate(o.payFrom)) c.payFrom = o.payFrom;
  if (validDate(o.payTo)) c.payTo = o.payTo;
  if (Array.isArray(o.products)) { const p = [...new Set(o.products.map((x) => String(x ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300)).filter(Boolean))].slice(0, 50); if (p.length) c.products = p; }
  for (const k of Object.keys(c) as (keyof SubCond)[]) if (c[k] === undefined) delete c[k];
  return c;
}
export const isEmptySubCond = (c: SubCond): boolean => Object.keys(c).length <= 1; // mode 뿐

const range = (a?: string, b?: string) => `${a || "처음"}~${b || "오늘"}`;
const roundText = (c: SubCond) => (c.minRound && c.maxRound ? (c.minRound === c.maxRound ? `${c.minRound}회차` : `${c.minRound}~${c.maxRound}회차`) : c.minRound ? `${c.minRound}회차 이상` : `${c.maxRound}회차 이하`);
// 기록·화면에 남기는 조건 한 줄
export function subSummary(c: SubCond): string {
  const parts: string[] = ["정기배송"];
  if (c.states?.length) parts.push(`상태 ${c.states.map((s) => SUB_STATE_LABEL[s]).join("/")}`);
  if (c.changedFrom || c.changedTo) parts.push(`상태 바뀐 날 ${range(c.changedFrom, c.changedTo)}`);
  if (c.minRound || c.maxRound) parts.push(roundText(c));
  if (c.payFrom || c.payTo) parts.push(`다음 결제 예정일 ${range(c.payFrom, c.payTo)}`);
  if (c.products?.length) parts.push(`상품 ${c.products.map((n) => `'${n}'`).join(", ")}`);
  return parts.join(" · ");
}
// 엑셀 '추출 정보' 시트용
export function subLines(c: SubCond): [string, string][] {
  const out: [string, string][] = [["대상", "정기배송 고객"]];
  if (c.states?.length) out.push(["상태", c.states.map((s) => SUB_STATE_LABEL[s]).join(", ")]);
  if (c.changedFrom || c.changedTo) out.push(["상태 바뀐 날", `${c.changedFrom || "처음"} ~ ${c.changedTo || "오늘"}`]);
  if (c.minRound || c.maxRound) out.push(["회차", roundText(c)]);
  if (c.payFrom || c.payTo) out.push(["다음 결제 예정일", `${c.payFrom || "처음"} ~ ${c.payTo || "오늘"}`]);
  if (c.products?.length) out.push(["정기배송 상품", c.products.join(", ")]);
  return out;
}

// 조건에 맞는 신청 한 줄씩(전화번호 없음). withLog=false 는 상태 변화 기록 표(129)가 없을 때 — 해지일만 안다.
//  상태 바뀐 날: 해지 = 품목 해지일(없으면 기록), 일시정지·이용중 = 기록에서 지금 상태로 바뀐 마지막 날.
//   기록의 prev_state 가 비어 있는 줄은 '처음 관측'이라 실제로 바뀐 날이 아니다 — 쓰지 않는다(기록은 2026-10-08 부터).
function subSql(c: SubCond, withLog: boolean): string {
  const w: string[] = [];
  if (c.states?.length) w.push(`c.state in (${c.states.map(lit).join(",")})`);
  if (c.products?.length) w.push(`exists (select 1 from cafe24_subscription_items x where x.subscription_id = c.subscription_id and x.product_name in (${c.products.map(lit).join(",")}))`);
  const h: string[] = [];
  if (c.minRound) h.push(`s.round >= ${c.minRound}`);
  if (c.maxRound) h.push(`s.round <= ${c.maxRound}`);
  if (c.payFrom) h.push(`s.next_pay >= ${lit(c.payFrom)}`);
  if (c.payTo) h.push(`s.next_pay <= ${lit(c.payTo)}`);
  if (c.changedFrom) h.push(`s.changed_on >= ${lit(c.changedFrom)}`);
  if (c.changedTo) h.push(`s.changed_on <= ${lit(c.changedTo)}`);
  const changed = withLog ? "case when c.state = 'C' then coalesce(it.terminated, lg.changed_on) else lg.changed_on end" : "case when c.state = 'C' then it.terminated else null end";
  return `
    with it as (
      select subscription_id, max(sequence) as round, min(expected_pay_date) filter (where state = 'U') as next_pay, max(terminated_date) as terminated,
             left(string_agg(distinct product_name, ' / '), 500) as items,
             left(string_agg(distinct product_code, ', ') filter (where coalesce(product_code, '') <> ''), 300) as codes
      from cafe24_subscription_items group by subscription_id
    ),
    ${withLog ? `lg as (
      select distinct on (subscription_id, new_state) subscription_id, new_state, changed_on
      from cafe24_subscription_state_log where prev_state is not null
      order by subscription_id, new_state, changed_on desc
    ),` : ""}
    s as (
      select c.subscription_id, c.state, it.round, it.next_pay::text as next_pay, (${changed})::text as changed_on, it.items, it.codes
      from cafe24_subscriptions c left join it on it.subscription_id = c.subscription_id
      ${withLog ? "left join lg on lg.subscription_id = c.subscription_id and lg.new_state = c.state" : ""}
      ${w.length ? `where ${w.join(" and ")}` : ""}
    ),
    pk as (
      select distinct on (p.subscription_id) p.subscription_id, o.customer_key
      from cafe24_subscription_payments p join sales_orders o on o.order_id = p.order_id
      where o.customer_key <> '' order by p.subscription_id, o.order_date desc
    )
    select s.subscription_id, s.state, s.round, s.next_pay, s.changed_on, s.items, s.codes, pk.customer_key
    from s left join pk on pk.subscription_id = s.subscription_id
    ${h.length ? `where ${h.join(" and ")}` : ""}
    order by s.subscription_id desc`;
}

type Raw = { subscription_id: string; state: string | null; round: number | null; next_pay: string | null; changed_on: string | null; items: string | null; codes: string | null; customer_key: string | null };
const uniqJoin = (parts: string[], sep: string) => [...new Set(parts.flatMap((p) => p.split(sep).map((x) => x.trim())).filter(Boolean))].join(sep);

export async function findSubAudience(sb: SupabaseClient, c: SubCond): Promise<SubFound> {
  let raw: Raw[];
  let noLog = false;
  try { raw = await runSql<Raw>(sb, subSql(c, true), MAX_AUDIENCE + 1); }
  catch (e) {
    // 상태 변화 기록 표(129)가 없는 환경 — 기록 없이 다시(해지일만 안다)
    if (!/cafe24_subscription_state_log/.test(e instanceof Error ? e.message : String(e))) throw e;
    noLog = true;
    raw = await runSql<Raw>(sb, subSql(c, false), MAX_AUDIENCE + 1);
  }
  const capped = raw.length > MAX_AUDIENCE;
  const list = capped ? raw.slice(0, MAX_AUDIENCE) : raw;
  const by = new Map<string, Raw[]>();
  let unlinked = 0;
  for (const r of list) {
    if (!r.customer_key) { unlinked++; continue; }
    const a = by.get(r.customer_key); if (a) a.push(r); else by.set(r.customer_key, [r]);
  }
  const rows: SubRow[] = [];
  for (const [customer_key, subs] of by) {
    const rounds = subs.map((x) => Number(x.round)).filter((n) => Number.isFinite(n) && n > 0);
    const pays = subs.map((x) => x.next_pay).filter((x): x is string => !!x).sort();
    const changes = subs.map((x) => x.changed_on).filter((x): x is string => !!x).sort();
    rows.push({
      customer_key,
      states: [...new Set(subs.map((x) => SUB_STATE_LABEL[x.state as SubState] ?? (x.state || "")))].filter(Boolean).join(", "),
      round: rounds.length ? Math.max(...rounds) : null,
      next_pay: pays[0] ?? null,
      changed_on: changes[changes.length - 1] ?? null,
      items: uniqJoin(subs.map((x) => x.items || ""), " / "),
      codes: uniqJoin(subs.map((x) => x.codes || ""), ", "),
      sub_ids: subs.map((x) => x.subscription_id).join(", "),
      subs: subs.length,
    });
  }
  return { rows, subs: list.length, unlinked, capped, noLog };
}

// 연락처를 붙이고, 메시지가 가지 않는 번호(안심번호 050·번호 없음)를 걸러 낸다 — 정기배송 고객은 수천 명 이하라 검색 때도 전원을 읽는다.
export async function withContacts(sb: SupabaseClient, rows: SubRow[]): Promise<{ list: { row: SubRow; contact: Contact }[]; excluded: number }> {
  const contacts = await loadContacts(sb, rows.map((r) => r.customer_key));
  const list: { row: SubRow; contact: Contact }[] = [];
  let excluded = 0;
  for (const row of rows) {
    const c = contacts.get(row.customer_key);
    const d = (c?.phone || "").replace(/\D/g, "");
    if (!c || d.length < 9 || d.startsWith("050")) { excluded++; continue; }
    list.push({ row, contact: c });
  }
  return { list, excluded };
}

// 정기배송 상품 선택지 — 신청 품목에 나온 상품명(신청 많은 순)
export type SubProductOption = { name: string; subs: number };
export async function listSubProducts(sb: SupabaseClient): Promise<SubProductOption[]> {
  const rows = await runSql<{ name: string; subs: number }>(sb, `
    select product_name as name, count(distinct subscription_id)::int as subs
    from cafe24_subscription_items where coalesce(product_name, '') <> '' group by product_name order by subs desc`, 1000);
  return rows.map((r) => ({ name: r.name, subs: Number(r.subs) || 0 }));
}
