// 오디언스 추출 — 정기배송 고객(2026-11-13 대표: 일시정지 중·일시정지 오래됨·최근 해지·n회차 이상·결제 예정일·특정 상품). 서버 전용.
//  정기배송 상태는 매일 23:59 중계 서버가 카페24에서 가져와 쌓는다(migration 127 cafe24_subscriptions·items·payments).
//  거기엔 이름·전화번호가 없다(일부러 저장하지 않음). 전화번호는 이렇게 잇는다:
//    정기배송 신청 → 회차별 결제 주문번호(cafe24_subscription_payments.order_id) → 매출 주문(sales_orders.order_id) → 고객 키 → sales_customers
//  (주문번호 형식이 양쪽 같다 — 매출 리포트의 정기배송 매출이 같은 조인을 쓴다, 2026-10-19 확인.)
//  결제 주문이 매출 원장에 없는 신청은 번호를 못 찾는다 — 몇 건인지 결과에 함께 돌려준다.
//
//  ★ 상태는 '품목' 단위로 본다(2026-11-13 실측 — 최근 6개월 신청 307건).
//    카페24의 신청 단위 상태(cafe24_subscriptions.state)는 U(이용중)·C(해지)뿐이고 일시정지는 나오지 않는다.
//    일시정지는 품목 상태 B(구매자)·Q(관리자)로만 온다(신청=U / 품목=B 가 26건). 그래서 신청 단위 상태로 찾으면 일시정지가 0명이 된다.
//    품목 상태: U 이용중 / B·Q 일시정지 / M·A·O 해지. 조건 '상태'와 '상품'은 같은 품목에 함께 건다(그 상품을 그 상태로 둔 신청).
//  ★ 일시정지한 날은 어디에도 없다(카페24가 주지 않고, 상태 변화 기록 129 도 신청 단위 상태만 적어 일시정지가 안 남는다).
//    대신 '마지막 결제일'을 조건으로 준다 — 일시정지 + 마지막 결제일이 오래됨 = 쉰 지 오래된 고객.
//
//  ★ 상태를 세는 기준은 둘이다(2026-11-13 대표 확정).
//    품목 기준 — 품목마다 이용중·일시정지·해지. 고른 상태의 품목을 하나라도 가진 고객이 나온다.
//    사람 기준 — 그 사람의 모든 신청·품목을 통틀어: 이용중 품목이 하나라도 있으면 이용중, 이용중은 없고 일시정지 품목이 있으면 일시정지, 전부 해지면 해지.
//    그래서 조회는 조건에 안 맞는 신청까지 전부 읽고, 거르기는 코드에서 한다(신청은 수천 건 이하).
//    사람 기준에 상품을 함께 걸면 '그 상태인 사람 가운데 그 상품을 그 상태로 둔 사람'이다.
//    엑셀의 '일시정지 구분'은 참고 칸이다 — 전체 = 일시정지 품목이 있고 이용중이 없음(= 사람 기준 일시정지), 부분 = 일시정지와 이용중이 함께 있음(= 사람 기준 이용중).
//
//  한 고객이 신청을 여러 개 가질 수 있어 결과는 고객 단위로 묶는다(상품은 이어 적고, 회차는 큰 값, 결제 예정일은 빠른 날).
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSql } from "./analyst";
import { loadContacts, MAX_AUDIENCE, type Contact } from "./audience";

export const SUB_STATES = ["U", "P", "C"] as const;
export type SubState = (typeof SUB_STATES)[number];
export const SUB_STATE_LABEL: Record<SubState, string> = { U: "이용중", P: "일시정지", C: "해지" };
export type SubBasis = "item" | "person";
export const SUB_BASIS_LABEL: Record<SubBasis, string> = { item: "품목 기준", person: "사람 기준" };
export type PauseKind = "all" | "part";
export const PAUSE_KIND_LABEL: Record<PauseKind, string> = { all: "전체 일시정지", part: "부분 일시정지" };
// 조건의 상태 → 카페24 품목 상태 코드
const ITEM_STATES: Record<SubState, string[]> = { U: ["U"], P: ["B", "Q"], C: ["M", "A", "O"] };

export type SubCond = {
  mode: "sub";
  states?: SubState[];                 // 상태(여러 개 = 그중 하나)
  basis?: SubBasis;                    // 상태를 세는 기준 — 상태를 골랐을 때만 들어간다
  products?: string[];                 // 정기배송 상품명(정확히 일치, 여러 개 = 그중 하나) — 상태와 같은 품목에 함께 건다
  minRound?: number; maxRound?: number;     // 회차(신청 품목 중 가장 큰 회차)
  payFrom?: string; payTo?: string;         // 다음 결제 예정일(이용중 품목 중 가장 빠른 날)
  lastPaidFrom?: string; lastPaidTo?: string; // 마지막 결제일(결제 완료 기준)
  termFrom?: string; termTo?: string;       // 해지일(품목 해지일 중 가장 늦은 날)
};
// 고객 한 명(신청 여러 개면 묶음)
export type SubRow = { customer_key: string; person: string; states: string; pause_kind: string; round: number | null; next_pay: string | null; last_paid: string | null; terminated: string | null; items: string; codes: string; sub_ids: string; subs: number };
export type SubFound = { rows: SubRow[]; subs: number; unlinked: number; capped: boolean };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const posInt = (v: unknown): number | undefined => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };

export const isSubCond = (raw: unknown): boolean => !!raw && typeof raw === "object" && (raw as { mode?: unknown }).mode === "sub";

export function normalizeSubCond(raw: unknown): SubCond {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: SubCond = { mode: "sub" };
  if (Array.isArray(o.states)) { const st = SUB_STATES.filter((s) => (o.states as unknown[]).includes(s)); if (st.length) c.states = st; }
  // 옛 기록(11-13 오전 베타)의 pauseKind — 전체 일시정지는 사람 기준 일시정지와 같은 뜻이라 그렇게 옮긴다
  if (c.states) c.basis = o.basis === "person" || (o.basis == null && o.pauseKind === "all") ? "person" : "item";
  if (Array.isArray(o.products)) { const p = [...new Set(o.products.map((x) => String(x ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300)).filter(Boolean))].slice(0, 50); if (p.length) c.products = p; }
  c.minRound = posInt(o.minRound); c.maxRound = posInt(o.maxRound);
  for (const k of ["payFrom", "payTo", "lastPaidFrom", "lastPaidTo", "termFrom", "termTo"] as const) if (validDate(o[k])) c[k] = o[k] as string;
  for (const k of Object.keys(c) as (keyof SubCond)[]) if (c[k] === undefined) delete c[k];
  return c;
}
export const isEmptySubCond = (c: SubCond): boolean => Object.keys(c).length <= 1; // mode 뿐

const range = (a?: string, b?: string) => `${a || "처음"}~${b || "오늘"}`;
const roundText = (c: SubCond) => (c.minRound && c.maxRound ? (c.minRound === c.maxRound ? `${c.minRound}회차` : `${c.minRound}~${c.maxRound}회차`) : c.minRound ? `${c.minRound}회차 이상` : `${c.maxRound}회차 이하`);
// 기록·화면에 남기는 조건 한 줄
export function subSummary(c: SubCond): string {
  const parts: string[] = ["정기배송"];
  if (c.states?.length) parts.push(`${SUB_BASIS_LABEL[c.basis || "item"]} ${c.states.map((s) => SUB_STATE_LABEL[s]).join("/")}`);
  if (c.products?.length) parts.push(`상품 ${c.products.map((n) => `'${n}'`).join(", ")}`);
  if (c.minRound || c.maxRound) parts.push(roundText(c));
  if (c.payFrom || c.payTo) parts.push(`다음 결제 예정일 ${range(c.payFrom, c.payTo)}`);
  if (c.lastPaidFrom || c.lastPaidTo) parts.push(`마지막 결제일 ${range(c.lastPaidFrom, c.lastPaidTo)}`);
  if (c.termFrom || c.termTo) parts.push(`해지일 ${range(c.termFrom, c.termTo)}`);
  return parts.join(" · ");
}
// 엑셀 '추출 정보' 시트용
export function subLines(c: SubCond): [string, string][] {
  const out: [string, string][] = [["대상", "정기배송 고객"]];
  if (c.states?.length) out.push(["상태 기준", SUB_BASIS_LABEL[c.basis || "item"]], ["상태", c.states.map((s) => SUB_STATE_LABEL[s]).join(", ")]);
  if (c.products?.length) out.push(["정기배송 상품", c.products.join(", ")]);
  if (c.minRound || c.maxRound) out.push(["회차", roundText(c)]);
  if (c.payFrom || c.payTo) out.push(["다음 결제 예정일", `${c.payFrom || "처음"} ~ ${c.payTo || "오늘"}`]);
  if (c.lastPaidFrom || c.lastPaidTo) out.push(["마지막 결제일", `${c.lastPaidFrom || "처음"} ~ ${c.lastPaidTo || "오늘"}`]);
  if (c.termFrom || c.termTo) out.push(["해지일", `${c.termFrom || "처음"} ~ ${c.termTo || "오늘"}`]);
  return out;
}

// 신청 전체를 한 줄씩 읽는다(전화번호 없음) — 조건에 안 맞는 신청도 읽어야 고객의 사람 기준 상태를 가릴 수 있다.
//  m_u·m_p·m_c = 상품 조건에 맞는 품목 가운데 이용중·일시정지·해지인 것의 수(상태와 상품은 같은 품목에 건다).
//  has_u·has_p·has_c = 그 신청이 가진 품목 상태(상품 조건과 무관). pass = 회차·날짜 조건 통과.
//  상품명·코드는 상태별로 따로 싣는다 — 어느 상태의 것을 보일지는 고객마다 코드에서 고른다.
function subSql(c: SubCond): string {
  const prod = c.products?.length ? `product_name in (${c.products.map(lit).join(",")})` : "true";
  const h: string[] = [];
  if (c.minRound) h.push(`it.round >= ${c.minRound}`);
  if (c.maxRound) h.push(`it.round <= ${c.maxRound}`);
  if (c.payFrom) h.push(`it.next_pay >= ${lit(c.payFrom)}`);
  if (c.payTo) h.push(`it.next_pay <= ${lit(c.payTo)}`);
  if (c.lastPaidFrom) h.push(`lp.last_paid >= ${lit(c.lastPaidFrom)}`);
  if (c.lastPaidTo) h.push(`lp.last_paid <= ${lit(c.lastPaidTo)}`);
  if (c.termFrom) h.push(`it.terminated >= ${lit(c.termFrom)}`);
  if (c.termTo) h.push(`it.terminated <= ${lit(c.termTo)}`);
  const per = (k: "u" | "p" | "c", st: string) => `
             count(*) filter (where (${prod}) and ${st})::int as m_${k},
             left(string_agg(distinct product_name, ' / ') filter (where (${prod}) and ${st}), 500) as items_${k},
             left(string_agg(distinct product_code, ', ') filter (where (${prod}) and ${st} and coalesce(product_code, '') <> ''), 300) as codes_${k},`;
  return `
    with it as (
      select subscription_id,${per("u", "state = 'U'")}${per("p", "state in ('B','Q')")}${per("c", "state in ('M','A','O')")}
             bool_or(state = 'U') as has_u, bool_or(state in ('B','Q')) as has_p, bool_or(state in ('M','A','O')) as has_c,
             max(sequence) as round, min(expected_pay_date) filter (where state = 'U') as next_pay, max(terminated_date) as terminated
      from cafe24_subscription_items group by subscription_id
    ),
    lp as (
      select subscription_id, (max(payment_date) at time zone 'Asia/Seoul')::date as last_paid
      from cafe24_subscription_payments where coalesce(status, '') <> 'failed' group by subscription_id
    ),
    pk as (
      select distinct on (p.subscription_id) p.subscription_id, o.customer_key
      from cafe24_subscription_payments p join sales_orders o on o.order_id = p.order_id
      where o.customer_key <> '' order by p.subscription_id, o.order_date desc
    )
    select it.subscription_id, it.m_u, it.m_p, it.m_c, it.has_u, it.has_p, it.has_c, it.round,
           it.items_u, it.items_p, it.items_c, it.codes_u, it.codes_p, it.codes_c,
           it.next_pay::text as next_pay, lp.last_paid::text as last_paid, it.terminated::text as terminated,
           (${h.length ? h.join(" and ") : "true"}) as pass, pk.customer_key
    from it left join lp on lp.subscription_id = it.subscription_id left join pk on pk.subscription_id = it.subscription_id
    order by it.subscription_id desc`;
}

type Raw = {
  subscription_id: string; m_u: number; m_p: number; m_c: number; has_u: boolean; has_p: boolean; has_c: boolean; pass: boolean | null;
  items_u: string | null; items_p: string | null; items_c: string | null; codes_u: string | null; codes_p: string | null; codes_c: string | null;
  round: number | null; next_pay: string | null; last_paid: string | null; terminated: string | null; customer_key: string | null;
};
const uniqJoin = (parts: string[], sep: string) => [...new Set(parts.flatMap((p) => p.split(sep).map((x) => x.trim())).filter(Boolean))].join(sep);
const kindOf = (hasP: boolean, hasU: boolean): PauseKind | null => (hasP ? (hasU ? "part" : "all") : null);
const LOW: Record<SubState, "u" | "p" | "c"> = { U: "u", P: "p", C: "c" };
// 사람 기준 상태 — 그 사람의 모든 신청·품목을 통틀어: 이용중이 하나라도 있으면 이용중, 없고 일시정지가 있으면 일시정지, 전부 해지면 해지.
export const personState = (hasU: boolean, hasP: boolean, hasC: boolean): SubState | null => (hasU ? "U" : hasP ? "P" : hasC ? "C" : null);

// 고객 한 명의 신청 묶음 → 조건에 맞는가. subs = 그 고객의 모든 신청(조건에 안 맞는 것 포함).
//  target = 이 고객에게서 찾을 품목 상태. 품목 기준이면 고른 상태 그대로, 사람 기준이면 고른 상태 가운데 이 사람의 상태 하나(없으면 탈락).
//  상태를 안 골랐으면 세 상태 전부(= 상품·회차·날짜만 따진다).
function pickCustomer(c: SubCond, subs: Raw[]): { hit: Raw[]; target: SubState[]; person: SubState | null; kind: PauseKind | null } | null {
  const hasU = subs.some((x) => x.has_u), hasP = subs.some((x) => x.has_p), hasC = subs.some((x) => x.has_c);
  const person = personState(hasU, hasP, hasC);
  const target: SubState[] = !c.states?.length ? [...SUB_STATES] : c.basis === "person" ? c.states.filter((s) => s === person) : c.states;
  if (!target.length) return null;
  // 조건의 날짜·회차가 비어 있는 신청(비교 결과 null)도 탈락
  const hit = subs.filter((x) => x.pass === true && target.some((s) => x[`m_${LOW[s]}`] > 0));
  return hit.length ? { hit, target, person, kind: kindOf(hasP, hasU) } : null;
}

export async function findSubAudience(sb: SupabaseClient, c: SubCond): Promise<SubFound> {
  const raw = await runSql<Raw>(sb, subSql(c), MAX_AUDIENCE + 1);
  const capped = raw.length > MAX_AUDIENCE;
  const list = capped ? raw.slice(0, MAX_AUDIENCE) : raw;
  const by = new Map<string, Raw[]>();
  const loose: Raw[] = []; // 전화번호와 잇지 못한 신청 — 신청 하나를 고객 하나로 보고 조건만 따진다
  for (const r of list) {
    if (!r.customer_key) { loose.push(r); continue; }
    const a = by.get(r.customer_key); if (a) a.push(r); else by.set(r.customer_key, [r]);
  }
  const unlinked = loose.filter((r) => pickCustomer(c, [r])).length;
  const rows: SubRow[] = [];
  let subs = unlinked;
  for (const [customer_key, all] of by) {
    const p = pickCustomer(c, all);
    if (!p) continue;
    subs += p.hit.length;
    const rounds = p.hit.map((x) => Number(x.round)).filter((n) => Number.isFinite(n) && n > 0);
    const dates = (k: "next_pay" | "last_paid" | "terminated") => p.hit.map((x) => x[k]).filter((x): x is string => !!x).sort();
    rows.push({
      customer_key,
      // 상태 세 칸은 그 고객의 모든 신청 기준(조건에 맞은 신청만이 아니라)
      person: p.person ? SUB_STATE_LABEL[p.person] : "",
      states: [all.some((x) => x.has_u) && "이용중", all.some((x) => x.has_p) && "일시정지", all.some((x) => x.has_c) && "해지"].filter(Boolean).join(", "),
      pause_kind: p.kind ? PAUSE_KIND_LABEL[p.kind] : "",
      round: rounds.length ? Math.max(...rounds) : null,
      next_pay: dates("next_pay")[0] ?? null,
      last_paid: dates("last_paid").pop() ?? null,
      terminated: dates("terminated").pop() ?? null,
      items: uniqJoin(p.hit.flatMap((x) => p.target.map((s) => x[`items_${LOW[s]}`] || "")), " / "),
      codes: uniqJoin(p.hit.flatMap((x) => p.target.map((s) => x[`codes_${LOW[s]}`] || "")), ", "),
      sub_ids: p.hit.map((x) => x.subscription_id).join(", "),
      subs: p.hit.length,
    });
  }
  return { rows, subs, unlinked, capped };
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
