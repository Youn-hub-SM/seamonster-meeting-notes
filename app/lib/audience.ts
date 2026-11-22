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
import { normalizeExcludeForms, excludeText, type ExcludeForm } from "./audience-tally";

// 조건 묶음 하나 — 주문의 범위(구매 기간·채널·상품)와 그 범위에서 센 값(주문 횟수·누적 금액)으로 고객을 고른다.
export type AudienceGroup = {
  from?: string; to?: string;            // 구매 기간 — 이 기간에 산 고객
  channels?: string[];                   // 그 구매의 채널(여러 개 = 그중 하나)
  skus?: { sku: string; label: string }[]; // 그 구매의 상품 — 목록에서 고른 상품(상품코드 정확히 일치). label 은 기록에 보일 이름
  names?: string[];                      // 그 구매의 상품 — 목록에서 고른 주문 상품명(주문서에 적힌 이름과 정확히 일치)
  products?: string;                     // 그 구매의 상품 — 상품명·상품코드에 든 말, 쉼표로 여러 개. skus·names 와 합쳐 '그중 하나라도'
  only?: boolean;                        // 이 상품만 산 고객 — 묶음의 구매 기간·채널 안에서 고른 상품 말고는 산 적이 없다(상품을 골랐을 때만)
  minOrders?: number; maxOrders?: number; // 범위 안 주문 횟수
  minAmount?: number;                    // 범위 안 누적 구매 금액(원)
  lastFrom?: string; lastTo?: string;    // 마지막 구매일(채널만 걸고 전체 기간)
};
// 조건 묶음을 여러 개 두고 '그리고' 또는 '또는'으로 잇는다(2026-11-22 대표: "and or 등을 넣어서 고도화한 필터링").
//  맨 위 칸 = 조건 1 — 옛 기록·옛 화면의 조건(묶음 하나)이 그대로 읽힌다. more = 조건 2부터.
//  match = 묶음 사이. 없으면 '그리고'(모두 만족), "any" 면 '또는'(하나라도 만족). 한 번의 검색에서 섞지 않는다(대표 결정 — 괄호 없이 읽히게).
//  excludes = 제외 묶음 — 그 묶음에 맞는 고객은 뺀다(묶음이 여러 개면 하나라도 맞으면 뺀다).
export type AudienceCond = AudienceGroup & {
  more?: AudienceGroup[]; match?: "any"; excludes?: AudienceGroup[];
  excludeForms?: ExcludeForm[];          // 탈리 폼 응답자 빼기(audience-tally.ts) — 찾는 조건이 아니라 찾은 고객에서 빼는 것
};
export const MAX_GROUPS = 5; // 조건 묶음·제외 묶음 각각
// items·codes·order_names·channels = 조건(구매 기간·채널·상품)에 맞은 주문의 것 — 그 고객이 왜 뽑혔는지가 엑셀에 보인다(2026-11-13 대표: "추출시 적용된 필터가 나오면 좋겠음")
//  orders·amount = 그 고객이 맞은 첫 묶음의 값. groups = 묶음마다의 값(그 묶음에 맞지 않았으면 null — '또는'일 때).
export type AudienceRow = { customer_key: string; orders: number; amount: number; first_date: string; last_date: string; items: string; codes: string; order_names: string; channels: string; groups: ({ orders: number; amount: number } | null)[] };
export type AudienceFound = { rows: AudienceRow[]; excluded: number; capped: boolean };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;                       // SQL 문자열
const likeLit = (s: string) => lit(`%${s.replace(/[\\%_]/g, "\\$&")}%`);       // 포함 검색(와일드카드 무력화)
const posInt = (v: unknown): number | undefined => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };
export const MAX_AUDIENCE = 50_000; // 한 번에 다루는 고객 수 상한
const LIST_LIMIT = 6000; // 선택지 조회가 받는 줄 수 — 결과는 잘라 쓴다

// 오래 걸리는 조회 — run_report_long(migration 174, 제한 60초)으로 부른다.
//  run_report 본문의 set_config('statement_timeout')는 이미 실행 중인 그 호출에 듣지 않아, 실제 제한은 API 역할 기본값(약 8초)이었다
//  (2026-11-20 베타에서 [고객 찾기]가 8초쯤에 끊김). 174 가 아직 없으면 run_report 로 부른다(그때는 약 8초 제한 그대로).
const TIMEOUT_MSG = "조회가 제한 시간을 넘겨 멈췄습니다. 구매 기간·채널·상품 조건을 넣어 범위를 좁힌 뒤 다시 찾으세요.";
const isTimeout = (m: string) => /statement timeout|canceling statement/i.test(m);
export async function runLong<T>(sb: SupabaseClient, q: string, limit: number): Promise<T[]> {
  const { data, error } = await sb.rpc("run_report_long", { q, p_limit: limit });
  if (!error) return (Array.isArray(data) ? data : []) as T[];
  if (isTimeout(error.message || "")) throw new Error(TIMEOUT_MSG);
  if (error.code !== "PGRST202" && !/could not find the function/i.test(error.message || "")) throw new Error(`집계 실패: ${error.message}`);
  try { return await runSql<T>(sb, q, limit); }
  catch (e) { if (e instanceof Error && isTimeout(e.message)) throw new Error(TIMEOUT_MSG); throw e; }
}

// 화면에서 온 값을 다듬는다 — 형식이 틀린 값은 조건에서 뺀다(조건이 조용히 넓어지지 않게 호출부가 빈 조건을 막는다).
function normalizeGroup(raw: unknown): AudienceGroup {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: AudienceGroup = {};
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
  if (Array.isArray(o.names)) {
    const names = [...new Set(o.names.map((x) => String(x ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300)).filter(Boolean))].slice(0, 50);
    if (names.length) c.names = names;
  }
  const p = String(o.products || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20).join(", ");
  if (p) c.products = p;
  if (o.only === true && (c.skus || c.names || c.products)) c.only = true; // 상품을 고르지 않았으면 뜻이 없다
  c.minOrders = posInt(o.minOrders); c.maxOrders = posInt(o.maxOrders); c.minAmount = posInt(o.minAmount);
  if (validDate(o.lastFrom)) c.lastFrom = o.lastFrom;
  if (validDate(o.lastTo)) c.lastTo = o.lastTo;
  for (const k of Object.keys(c) as (keyof AudienceGroup)[]) if (c[k] === undefined) delete c[k];
  return c;
}
const isEmptyGroup = (g: AudienceGroup): boolean => Object.keys(g).length === 0;
const groupList = (raw: unknown): AudienceGroup[] => (Array.isArray(raw) ? raw : []).map(normalizeGroup).filter((g) => !isEmptyGroup(g));
export function normalizeCond(raw: unknown): AudienceCond {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // 찾는 묶음 = 맨 위 칸(조건 1) + more. 빈 묶음은 버리고 앞으로 당긴다.
  const inc = [normalizeGroup(o), ...groupList(o.more)].filter((g) => !isEmptyGroup(g)).slice(0, MAX_GROUPS);
  const c: AudienceCond = { ...(inc[0] || {}) };
  if (inc.length > 1) { c.more = inc.slice(1); if (o.match === "any") c.match = "any"; }
  const exc = groupList(o.excludes).slice(0, MAX_GROUPS);
  if (exc.length) c.excludes = exc;
  const forms = normalizeExcludeForms(o.excludeForms);
  if (forms) c.excludeForms = forms;
  return c;
}
// 찾는 묶음 목록(조건 1부터). 빈 조건이면 빈 배열.
const TOP_KEYS = new Set(["more", "match", "excludes", "excludeForms"]);
export function includeGroups(c: AudienceCond): AudienceGroup[] {
  const top = Object.fromEntries(Object.entries(c).filter(([k]) => !TOP_KEYS.has(k))) as AudienceGroup;
  return isEmptyGroup(top) ? [] : [top, ...(c.more || [])];
}
// 제외 묶음·응답자 빼기만 있고 찾는 조건이 없으면 빈 조건이다(전 고객을 뽑게 두지 않는다)
export const isEmptyCond = (c: AudienceCond): boolean => includeGroups(c).length === 0;
export const hasProduct = (g: AudienceGroup): boolean => !!(g.skus?.length || g.names?.length || g.products);

// 조건 검사 — 틀린 곳이 있으면 그 문구, 없으면 null
export function condError(c: AudienceCond): string | null {
  const inc = includeGroups(c);
  if (!inc.length) return "조건을 하나 이상 입력하세요.";
  const many = inc.length + (c.excludes?.length || 0) > 1;
  const check = (g: AudienceGroup, name: string): string | null => {
    const p = many ? `${name}: ` : "";
    if (g.from && g.to && g.from > g.to) return `${p}구매 기간의 시작일이 종료일보다 뒤입니다.`;
    if (g.lastFrom && g.lastTo && g.lastFrom > g.lastTo) return `${p}마지막 구매일의 시작일이 종료일보다 뒤입니다.`;
    if (g.minOrders && g.maxOrders && g.minOrders > g.maxOrders) return `${p}주문 횟수의 최소가 최대보다 큽니다.`;
    return null;
  };
  for (const [i, g] of inc.entries()) { const e = check(g, `조건 ${i + 1}`); if (e) return e; }
  for (const [i, g] of (c.excludes || []).entries()) { const e = check(g, `제외 ${i + 1}`); if (e) return e; }
  return null;
}

// 묶음 하나를 한 줄로
function groupText(c: AudienceGroup): string {
  const parts: string[] = [];
  if (c.from || c.to) parts.push(`구매 ${c.from || "처음"}~${c.to || "오늘"}`);
  if (c.channels?.length) parts.push(`채널 ${c.channels.join("/")}`);
  if (c.skus?.length) parts.push(`상품 ${c.skus.map((x) => (x.label ? `${x.label}(${x.sku})` : x.sku)).join(", ")}`);
  if (c.names?.length) parts.push(`주문 상품명 ${c.names.map((n) => `'${n}'`).join(", ")}`);
  if (c.products) parts.push(`상품명·코드에 '${c.products}' 포함`);
  if (c.only) parts.push("이 상품만 구매");
  if (c.minOrders || c.maxOrders) parts.push(c.minOrders && c.maxOrders ? (c.minOrders === c.maxOrders ? `주문 ${c.minOrders}회` : `주문 ${c.minOrders}~${c.maxOrders}회`) : c.minOrders ? `주문 ${c.minOrders}회 이상` : `주문 ${c.maxOrders}회 이하`);
  if (c.minAmount) parts.push(`누적 ${c.minAmount.toLocaleString("ko-KR")}원 이상`);
  if (c.lastFrom || c.lastTo) parts.push(`마지막 구매 ${c.lastFrom || "처음"}~${c.lastTo || "오늘"}`);
  return parts.join(" · ");
}
export const matchWord = (c: AudienceCond): string => (c.match === "any" ? "또는" : "그리고");

// 기록·화면에 남기는 조건 한 줄 — 묶음이 하나면 종전과 같은 글, 여러 개면 [조건 1 …] 그리고 [조건 2 …] · 제외 […]
export function condSummary(c: AudienceCond): string {
  const inc = includeGroups(c);
  const parts: string[] = [];
  if (inc.length === 1) parts.push(groupText(inc[0]));
  else if (inc.length > 1) parts.push(inc.map((g, i) => `[조건 ${i + 1}: ${groupText(g)}]`).join(` ${matchWord(c)} `));
  for (const g of c.excludes || []) parts.push(`제외 [${groupText(g)}]`);
  if (c.excludeForms?.length) parts.push(excludeText(c.excludeForms));
  return parts.filter(Boolean).join(" · ") || "조건 없음";
}

// 엑셀 '추출 정보' 시트용 — 적용한 조건을 항목별 한 줄씩(안 쓴 조건은 빠진다)
function groupLines(c: AudienceGroup, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  if (c.from || c.to) out.push([`${prefix}구매 기간`, `${c.from || "처음"} ~ ${c.to || "오늘"}`]);
  if (c.lastFrom || c.lastTo) out.push([`${prefix}마지막 구매일`, `${c.lastFrom || "처음"} ~ ${c.lastTo || "오늘"}`]);
  if (c.channels?.length) out.push([`${prefix}채널`, c.channels.join(", ")]);
  if (c.skus?.length) out.push([`${prefix}상품명(상품코드)`, c.skus.map((x) => (x.label ? `${x.label} (${x.sku})` : x.sku)).join(", ")]);
  if (c.names?.length) out.push([`${prefix}주문 상품명`, c.names.join(", ")]);
  if (c.products) out.push([`${prefix}이름·코드에 든 말`, c.products]);
  if (c.only) out.push([`${prefix}상품 범위`, "이 상품만 산 고객(구매 기간·채널 안에서 다른 상품은 산 적 없음)"]);
  if (c.minOrders || c.maxOrders) out.push([`${prefix}주문 횟수`, c.minOrders && c.maxOrders ? `${c.minOrders}~${c.maxOrders}회` : c.minOrders ? `${c.minOrders}회 이상` : `${c.maxOrders}회 이하`]);
  if (c.minAmount) out.push([`${prefix}누적 구매 금액`, `${c.minAmount.toLocaleString("ko-KR")}원 이상`]);
  return out;
}
export function condLines(c: AudienceCond): [string, string][] {
  const inc = includeGroups(c);
  const out: [string, string][] = [];
  if (inc.length <= 1 && !c.excludes?.length) out.push(...groupLines(inc[0] || {}));
  else {
    if (inc.length > 1) out.push(["조건 묶음 사이", c.match === "any" ? "또는 — 하나라도 맞는 고객" : "그리고 — 모두 맞는 고객"]);
    inc.forEach((g, i) => out.push(...groupLines(g, `조건 ${i + 1} · `)));
    (c.excludes || []).forEach((g, i) => out.push(...groupLines(g, `제외 ${i + 1} · `)));
  }
  if (c.excludeForms?.length) out.push(["탈리 응답자 제외", c.excludeForms.map((f) => f.name).join(", ")]);
  return out;
}

// ① 조건에 맞는 고객 — 전화번호 없이 키와 집계만.
//  묶음마다: hit = 구매 기간·채널·상품에 맞는 주문이 하나라도 있는 고객.
//  ■ 세는 범위(2026-11-22 대표 더블체크 — "카페24 10회 이상"은 카페24에서 10회, "기간도 그 기간 안에서", "광어 3번이면 광어를 포함한 주문을 3번 이상")
//    주문 횟수       = 조건(채널·구매 기간·상품)에 모두 맞는 주문의 수. 넣지 않은 조건은 제한 없음(하나도 없으면 전체 주문).
//    누적 구매 금액  = 같은 범위의 금액. 상품을 골랐으면 그 상품 줄의 금액만(같은 주문의 다른 상품 금액은 넣지 않는다).
//    첫/마지막 구매일 = 고른 채널의 주문 전체(구매 기간·상품은 걸지 않는다) — '작년에 샀고 그 뒤로 안 산 고객'처럼
//                       구매 기간과 마지막 구매일을 함께 쓰는 조건이 뜻을 잃지 않게.
//    이 상품만 산 고객 = 묶음의 구매 기간·채널 안에 고른 상품이 아닌 주문 줄이 하나도 없는 고객.
//  묶음 사이 = '그리고'는 교집합, '또는'은 합집합. 제외 묶음에 맞는 고객은 뺀다.
function groupCtes(g: AudienceGroup, t: string): string {
  const period = (al: string) => [g.from ? `${al}.order_date >= ${lit(g.from)}` : "", g.to ? `${al}.order_date <= ${lit(g.to)}` : ""].filter(Boolean);
  const chan = (al: string) => (g.channels?.length ? [`${al}.channel in (${g.channels.map(lit).join(",")})`] : []);
  // 상품 — 고른 상품(코드 정확히)·주문 상품명·포함어를 합쳐 '그중 하나라도'
  const prod = (al: string): string => {
    const p: string[] = [];
    if (g.skus?.length) p.push(`upper(${al}.sku_code) in (${g.skus.map((x) => lit(x.sku.toUpperCase())).join(",")})`);
    if (g.names?.length) p.push(`${al}.product_name in (${g.names.map(lit).join(",")})`);
    if (g.products) for (const k of g.products.split(",").map((x) => x.trim()).filter(Boolean)) p.push(`${al}.product_name ilike ${likeLit(k)} or ${al}.option_name ilike ${likeLit(k)} or ${al}.sku_code ilike ${likeLit(k)}`);
    return p.length ? `(${p.join(" or ")})` : "";
  };
  const w = ["o.customer_key <> ''", ...period("o"), ...chan("o"), prod("o")].filter(Boolean);
  // 주문 횟수·금액을 세는 범위 — 구매 기간과 상품(넣었을 때만). 채널은 where 에서 건다.
  const inScope = [...period("o"), prod("o")].filter(Boolean).join(" and ");
  const scope = inScope ? ` filter (where ${inScope})` : "";
  const h: string[] = [];
  if (g.minOrders) h.push(`a.orders >= ${g.minOrders}`);
  if (g.maxOrders) h.push(`a.orders <= ${g.maxOrders}`);
  if (g.minAmount) h.push(`a.amount >= ${g.minAmount}`);
  if (g.lastFrom) h.push(`a.last_date >= ${lit(g.lastFrom)}`);
  if (g.lastTo) h.push(`a.last_date <= ${lit(g.lastTo)}`);
  if (g.only && prod("o2")) h.push(`not exists (select 1 from sales_orders o2 where ${[`o2.customer_key = a.customer_key`, ...period("o2"), ...chan("o2"), `not ${prod("o2")}`].join(" and ")})`);
  return `
    m_${t} as (
      select o.customer_key, o.product_name, o.channel, upper(o.sku_code) as code,
             coalesce(nullif(concat_ws(' ', p.name, p.spec), ''), o.product_name) as item
      from sales_orders o left join products p on o.sku_code <> '' and upper(p.sku) = upper(o.sku_code)
      where ${w.join(" and ")}
    ),
    hit_${t} as (
      select customer_key, left(string_agg(distinct item, ' / '), 500) as items,
             left(string_agg(distinct code, ', ') filter (where code <> ''), 300) as codes,
             left(string_agg(distinct product_name, ' / '), 800) as order_names, string_agg(distinct channel, ', ') as channels
      from m_${t} group by customer_key
    ),
    a_${t} as (
      select o.customer_key, (count(distinct o.order_unit)${scope})::int as orders, coalesce(sum(o.subtotal_amount)${scope}, 0)::bigint as amount,
             min(o.order_date)::text as first_date, max(o.order_date)::text as last_date
      from sales_orders o join hit_${t} using (customer_key)${chan("o").length ? ` where ${chan("o")[0]}` : ""} group by o.customer_key
    ),
    s_${t} as (
      select a.customer_key, a.orders, a.amount, a.first_date, a.last_date, h.items, h.codes, h.order_names, h.channels
      from a_${t} a join hit_${t} h on h.customer_key = a.customer_key
      ${h.length ? `where ${h.join(" and ")}` : ""}
    )`;
}
export function audienceSql(c: AudienceCond): string {
  const inc = includeGroups(c), exc = c.excludes || [];
  const gi = inc.map((_, i) => `g${i + 1}`), xi = exc.map((_, i) => `x${i + 1}`);
  const ctes = [...inc.map((g, i) => groupCtes(g, gi[i])), ...exc.map((g, i) => groupCtes(g, xi[i]))];
  const keys = gi.map((t) => `select customer_key from s_${t}`).join(c.match === "any" ? " union " : " intersect ");
  const col = (name: string) => gi.map((t) => `s_${t}.${name}`);
  return `
    with ${ctes.join(",")},
    keys as (${keys})
    select k.customer_key, ${gi.map((t, i) => `s_${t}.orders as o${i + 1}, s_${t}.amount as m${i + 1}`).join(", ")},
           least(${col("first_date").join(", ")}) as first_date, greatest(${col("last_date").join(", ")}) as last_date,
           left(concat_ws(' / ', ${col("items").join(", ")}), 500) as items, left(concat_ws(', ', ${col("codes").join(", ")}), 300) as codes,
           left(concat_ws(' / ', ${col("order_names").join(", ")}), 800) as order_names, concat_ws(', ', ${col("channels").join(", ")}) as channels,
           (sc.customer_key is not null) as reachable
    from keys k ${gi.map((t) => `left join s_${t} on s_${t}.customer_key = k.customer_key`).join(" ")}
    left join sales_customer_summary sc on sc.customer_key = k.customer_key
    ${xi.length ? `where ${xi.map((t) => `not exists (select 1 from s_${t} where s_${t}.customer_key = k.customer_key)`).join(" and ")}` : ""}
    order by last_date desc, k.customer_key`;
}
export async function findAudience(sb: SupabaseClient, c: AudienceCond): Promise<AudienceFound> {
  const n = includeGroups(c).length;
  if (!n) throw new Error("조건을 하나 이상 입력하세요.");
  type R = Record<string, unknown> & { customer_key: string; first_date: string; last_date: string; items: string | null; codes: string | null; order_names: string | null; channels: string | null; reachable: boolean };
  const all = await runLong<R>(sb, audienceSql(c), MAX_AUDIENCE + 1);
  const capped = all.length > MAX_AUDIENCE;
  const list = capped ? all.slice(0, MAX_AUDIENCE) : all;
  const rows = list.filter((r) => r.reachable).map((r) => {
    const groups = Array.from({ length: n }, (_, i) => (r[`o${i + 1}`] == null ? null : { orders: Number(r[`o${i + 1}`]) || 0, amount: Number(r[`m${i + 1}`]) || 0 }));
    const first = groups.find((x) => x) || { orders: 0, amount: 0 };
    return { customer_key: r.customer_key, orders: first.orders, amount: first.amount, first_date: r.first_date, last_date: r.last_date, items: r.items || "", codes: r.codes || "", order_names: r.order_names || "", channels: r.channels || "", groups };
  });
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
  const rows = await runLong<{ sku: string; name: string | null; spec: string | null; listing: string | null; orders: number }>(sb, `
    select upper(o.sku_code) as sku, max(p.name) as name, max(p.spec) as spec, max(o.product_name) as listing, count(distinct o.order_unit)::int as orders
    from sales_orders o left join products p on upper(p.sku) = upper(o.sku_code)
    where o.sku_code <> '' group by upper(o.sku_code) order by orders desc`, LIST_LIMIT);
  return rows.slice(0, 3000).map((r) => ({ sku: r.sku, name: [r.name, r.spec].filter(Boolean).join(" · ") || (r.listing || r.sku), listing: r.listing || "", orders: Number(r.orders) || 0 }));
}

// 주문 상품명 선택지 — 주문서에 적힌 상품명 그대로(채널마다 이름이 다르다). 주문 많은 순.
export type OrderNameOption = { name: string; orders: number };
export async function listOrderNames(sb: SupabaseClient): Promise<OrderNameOption[]> {
  const rows = await runLong<{ name: string; orders: number }>(sb, `
    select o.product_name as name, count(distinct o.order_unit)::int as orders
    from sales_orders o where o.product_name <> '' group by o.product_name order by orders desc`, LIST_LIMIT);
  return rows.slice(0, 5000).map((r) => ({ name: r.name, orders: Number(r.orders) || 0 }));
}

// 채널 선택지 — 주문이 있는 채널(많은 순)
export async function listChannels(sb: SupabaseClient): Promise<string[]> {
  const rows = await runSql<{ channel: string }>(sb, `select channel, count(*) n from sales_orders where channel <> '' group by channel order by n desc`, 100);
  return rows.map((r) => r.channel);
}
