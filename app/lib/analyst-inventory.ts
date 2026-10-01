// 종합 리포트 '3. 재고' 사실 모으기(서버 전용) — 2026-10-01 대표 결정.
//  지금(생성 시점) 기준: 품절·부족·오는 중 — 생산요청 화면과 같은 계산(getInventoryRows '소매')이라 숫자가 일치한다.
//  기간 기준: 원장 합계(완료분, 칸 이동 제외)·기간 중 0이 된 품목·(월간) 재고 금액·매입액 — run_report 고정 집계문(1000행 캡 없음).
//  재고 경보는 flags 에 넣지 않는다 — flags 가 있으면 AI 조사 도구가 켜져 비용이 오른다(사실로만 넘긴다).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInventoryRows } from "./production-inventory";
import type { InventoryFacts, InvFlowRow, InvWatchRow } from "./report-sections";

type Range = { since: string; until: string };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
const r1 = (n: number) => Math.round(n * 10) / 10;

async function sql<T>(sb: SupabaseClient, q: string, limit = 200): Promise<T[]> {
  const { data, error } = await sb.rpc("run_report", { q, p_limit: limit });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as T[];
}

// 기간 원장 흐름 — 출고는 사유(폐기·협찬·기타)·B2B(차수 출고)·판매로 나눈다. 칸 이동(partner='채널이동')은 입·출고를 부풀리므로 뺀다.
//  금액은 현재 원가(products.cost_price) 기준 — 기간 중 원가 변경은 반영되지 않는다.
function flowSql(cur: Range, prev?: Range): string {
  const inCur = `t.txn_date between '${cur.since}' and '${cur.until}'`;
  const inPrev = prev ? `t.txn_date between '${prev.since}' and '${prev.until}'` : "false";
  return `select case when ${inCur} then 'cur' else 'prev' end as per,
  case when t.type <> '출고' then t.type when t.reason in ('폐기','협찬','기타') then t.reason when t.shipment_id is not null then 'B2B 출고' else '판매 출고' end as kind,
  coalesce(sum(abs(t.qty)), 0)::bigint as qty, coalesce(sum(t.qty), 0)::bigint as net, count(distinct t.product_id)::int as items,
  round(coalesce(sum(abs(t.qty) * coalesce(p.cost_price, 0)), 0))::bigint as cost
from inventory_txns t join products p on p.id = t.product_id
where t.status = '완료' and (${inCur} or ${inPrev})
  and coalesce(t.partner, '') <> '채널이동' and coalesce(p.stock_tracked, true)
group by 1, 2`;
}

// 기간 중 원장상 소매 재고가 0 이하였던 품목과 그 '달력 일수' — 거래 사이 구간 길이(다음 거래일까지, 마지막은 기간 끝까지)를 더한다.
//  기간 시작 전부터 0 이하였던 품목은 시작일에 0 수량 행을 넣어 첫 거래 전 구간도 센다(기간 중 거래가 있던 품목만 — 단종 품목이 목록을 채우지 않게).
//  사용 중(active)·재고 관리 품목만(재고 목록·생산요청 화면과 같은 범위).
function zeroedSql(cur: Range): string {
  return `with b as (select product_id, sum(qty) as q0 from inventory_txns where status = '완료' and channel = '소매' and txn_date < '${cur.since}' group by 1),
d0 as (select product_id, txn_date, sum(qty) as q from inventory_txns where status = '완료' and channel = '소매' and txn_date between '${cur.since}' and '${cur.until}' group by 1, 2),
d as (select * from d0 union all select b.product_id, date '${cur.since}', 0 from b where b.q0 <= 0 and exists (select 1 from d0 where d0.product_id = b.product_id)),
r as (select d.product_id, d.txn_date, coalesce(b.q0, 0) + sum(d.q) over w as bal, lead(d.txn_date, 1, date '${cur.until}' + 1) over w - d.txn_date as len
  from d left join b using (product_id) window w as (partition by d.product_id order by d.txn_date))
select p.name, (sum(r.len) filter (where r.bal <= 0))::int as zero_days, (min(r.txn_date) filter (where r.bal <= 0))::text as first_zero
from r join products p on p.id = r.product_id
where coalesce(p.stock_tracked, true) and coalesce(p.active, true)
group by p.id, p.name having sum(r.len) filter (where r.bal <= 0) > 0
order by zero_days desc, first_zero limit 5`;
}

// 월말·전월말 재고 금액(현재 원가) — 세트는 자체 재고가 없어 뺀다(구성품 이중 계산 방지)
function valueSql(end: string, prevEnd: string): string {
  return `with s as (select product_id, sum(qty) filter (where txn_date <= '${end}') as q1, sum(qty) filter (where txn_date <= '${prevEnd}') as q0
  from inventory_txns where status = '완료' group by 1)
select round(coalesce(sum(greatest(coalesce(s.q1, 0), 0) * coalesce(p.cost_price, 0)), 0))::bigint as v1,
  round(coalesce(sum(greatest(coalesce(s.q0, 0), 0) * coalesce(p.cost_price, 0)), 0))::bigint as v0,
  (count(*) filter (where s.q1 < 0))::int as neg
from s join products p on p.id = s.product_id
where coalesce(p.stock_tracked, true) and not exists (select 1 from product_bundles b where b.parent_id = p.id)`;
}

// 월 매입액(잠정) — 매입 결산(computeQuote)과 같은 계산: 입고·완료·도매 칸 제외·칸 이동 제외, 단가 × 수량에서
//  제조사 반품을 뺀다(단가 적은 반품은 그 단가, 안 적은 반품은 그 달 매입가, 그 달 매입이 없으면 마스터 매입단가).
function purchaseSql(cur: Range): string {
  return `with t as (select product_id, sum(round(abs(qty))) as q, sum(round(abs(qty)) * round(coalesce(unit_amount, 0))) as amt,
    sum(round(abs(qty))) filter (where coalesce(unit_amount, 0) <= 0) as npq
  from inventory_txns
  where type = '입고' and status = '완료' and channel <> '도매' and coalesce(partner, '') <> '채널이동'
    and txn_date between '${cur.since}' and '${cur.until}' group by 1),
r as (select product_id, sum(abs(round(qty, 2))) as rq, sum(round(unit_amount) * abs(round(qty, 2))) filter (where unit_amount > 0) as rfix,
    sum(abs(round(qty, 2))) filter (where unit_amount > 0) as rfq
  from purchase_returns where return_date between '${cur.since}' and '${cur.until}' group by 1)
select round(coalesce(sum(coalesce(t.amt, 0) - coalesce(r.rfix, 0)
    - (case when coalesce(t.q, 0) > 0 then round(t.amt / t.q) else round(coalesce(p.purchase_price, 0)) end) * greatest(0, coalesce(r.rq, 0) - coalesce(r.rfq, 0))), 0))::bigint as amount,
  coalesce(sum(t.npq), 0)::bigint as no_price_qty
from t full join r using (product_id) left join products p on p.id = product_id`;
}

const FLOW_ORDER = ["입고", "판매 출고", "B2B 출고", "폐기", "협찬", "기타", "조정"];
const sortFlow = (rows: InvFlowRow[]) => rows.sort((a, b) => FLOW_ORDER.indexOf(a.kind) - FLOW_ORDER.indexOf(b.kind));

export async function collectInventory(
  sb: SupabaseClient,
  opts: { period: "daily" | "weekly" | "monthly"; range: Range; prevRange?: Range; prevMonthEnd?: string },
): Promise<InventoryFacts> {
  const { period, range, prevRange } = opts;
  if (!DATE_RE.test(range.since) || !DATE_RE.test(range.until)) return { ok: false, note: "기간 오류", basis: "", now: null };
  const today = kstToday();
  // 끝난 지 7일 넘은 기간을 다시 만들면 오늘 재고가 그 기간 값처럼 보인다 — 지금 기준 목록은 뺀다
  const withNow = daysBetween(range.until, today) <= 7;
  const notes: string[] = [];

  const nowP = withNow ? (async () => {
    const [inv, inact] = await Promise.all([getInventoryRows("소매"), sb.from("products").select("sku").eq("active", false)]);
    // 사용 중(active) 품목만 — 재고 목록·요청 창·주간 초안이 보여 주는 품목과 같게(단종 품목이 품절로 잡히지 않게)
    const off = new Set(((inact.data ?? []) as { sku: string | null }[]).map((p) => String(p.sku ?? "").trim().toUpperCase()).filter(Boolean));
    if (inact.error) notes.push("단종 품목 조회 실패 — 단종 품목이 섞일 수 있음");
    const live = inv.rows.filter((r) => !off.has(String(r.sku || "").toUpperCase()));
    const rows = live.filter((r) => r.dailyOut > 0 && r.stock !== null);
    const soldout = rows.filter((r) => (r.stock ?? 0) <= 0).sort((a, b) => b.dailyOut - a.dailyOut);
    const short = rows.filter((r) => (r.stock ?? 0) > 0 && r.belowSafety)
      .sort((a, b) => (a.requestByDays ?? 9999) - (b.requestByDays ?? 9999) || a.name.localeCompare(b.name, "ko"));
    const daysOf = (r: { stock: number | null; dailyOut: number }) => (r.dailyOut > 0 ? Math.max(0, Math.floor(Math.max(0, r.stock ?? 0) / r.dailyOut)) : null);
    const watch: InvWatchRow[] = [...soldout.map((r) => ({ r, state: "품절" as const })), ...short.map((r) => ({ r, state: "부족" as const }))]
      .slice(0, 6)
      .map(({ r, state }) => ({ name: r.name, stock: r.stock ?? 0, daily: r1(r.dailyOut), days: daysOf(r), inbound: r.inbound, due: r.inboundDue, state }));
    const od = await sb.from("production_requests").select("id", { count: "exact", head: true })
      .in("status", ["요청", "진행중"]).eq("purpose", "재고 보충").lt("due_date", today);
    if (!inv.inboundOk) notes.push("입고 예정 집계 실패 — 부족 판정이 실제보다 많을 수 있음");
    if (od.error) notes.push("마감 지난 요청서 집계 실패");
    return {
      at: today,
      soldout: soldout.length,
      short: short.length,
      soldout_top: soldout.slice(0, 5).map((r) => r.name),
      urgent_top: short.slice(0, 3).map((r) => ({ name: r.name, days: daysOf(r), request_by_days: r.requestByDays })),
      inbound_total: Math.round(live.reduce((s, r) => s + (r.inbound || 0), 0)),
      inbound_overdue: Math.round(live.reduce((s, r) => s + (r.inboundOverdue || 0), 0)),
      overdue_requests: od.error ? null : od.count ?? 0,
      watch,
    };
  })() : Promise.resolve(null);

  const flowP = sql<{ per: string; kind: string; qty: number; net: number; items: number; cost: number }>(sb, flowSql(range, period === "daily" ? undefined : prevRange));
  const zeroP = period === "daily" ? Promise.resolve(null) : sql<{ name: string; zero_days: number; first_zero: string }>(sb, zeroedSql(range), 5);
  const valueP = period === "monthly" && opts.prevMonthEnd ? sql<{ v1: number; v0: number; neg: number }>(sb, valueSql(range.until, opts.prevMonthEnd), 1) : Promise.resolve(null);
  const purchaseP = period === "monthly" ? (async () => {
    const month = range.since.slice(0, 7);
    const snap = await sb.from("quote_snapshots").select("summary").eq("month", month).maybeSingle();
    const total = Number((snap.data as { summary?: { totalAmount?: number } } | null)?.summary?.totalAmount);
    if (!snap.error && Number.isFinite(total)) return { amount: Math.round(total), basis: "확정" as const };
    const [r] = await sql<{ amount: number; no_price_qty: number }>(sb, purchaseSql(range), 1);
    return { amount: Number(r?.amount) || 0, basis: "잠정" as const, no_price_qty: Number(r?.no_price_qty) || 0 };
  })() : Promise.resolve(null);

  const [nowR, flowR, zeroR, valueR, purR] = await Promise.allSettled([nowP, flowP, zeroP, valueP, purchaseP]);
  const fail = (what: string, r: PromiseSettledResult<unknown>) => { if (r.status === "rejected") notes.push(`${what} 집계 실패: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`.slice(0, 160)); };
  fail("지금 재고", nowR); fail("기간 입출고", flowR); fail("재고 0 품목", zeroR); fail("재고 금액", valueR); fail("매입액", purR);

  const flowRows = flowR.status === "fulfilled" ? flowR.value : [];
  const toRow = (r: { kind: string; qty: number; net: number; items: number; cost: number }): InvFlowRow =>
    ({ kind: r.kind, qty: Number(r.qty) || 0, net: Number(r.net) || 0, items: Number(r.items) || 0, cost: Number(r.cost) || 0 });
  const now = nowR.status === "fulfilled" ? nowR.value : null;
  const facts: InventoryFacts = {
    ok: now !== null || flowR.status === "fulfilled",
    basis: [
      now ? `품절 = 소매 현재고 0 이하·최근 30일 출고 있음, 부족 = 지금 요청해도 판매 가능일 전에 바닥날 품목(생산요청 화면과 같은 기준). 하루 출고 = 최근 30일 평균(행사 제외). 지금 = ${now.at} 리포트 생성 시각` : "",
      !withNow ? "끝난 지 7일이 지난 기간이라 지금 기준 품절·부족 목록은 생략" : "",
      "기간 입출고 = 재고 원장 완료분(칸 이동 제외), 판매 출고는 택배 발주처리 때 주문일로 기록되어 매출과 날짜가 어긋날 수 있음, 금액 = 현재 원가",
    ].filter(Boolean).join(". "),
    now,
    ...(flowR.status === "fulfilled" ? {
      flow: {
        cur: sortFlow(flowRows.filter((r) => r.per === "cur").map(toRow)),
        ...(period !== "daily" ? { prev: sortFlow(flowRows.filter((r) => r.per === "prev").map(toRow)) } : {}),
      },
    } : {}),
    ...(zeroR.status === "fulfilled" && zeroR.value ? { zeroed: zeroR.value.map((z) => ({ name: z.name, zero_days: Number(z.zero_days) || 0, first_zero: z.first_zero })) } : {}),
    ...(valueR.status === "fulfilled" && valueR.value?.[0] ? { value: { end: Number(valueR.value[0].v1) || 0, prev_end: Number(valueR.value[0].v0) || 0, neg_items: Number(valueR.value[0].neg) || 0 } } : {}),
    ...(purR.status === "fulfilled" && purR.value ? { purchase: purR.value } : {}),
    ...(notes.length ? { note: notes.join(" / ") } : {}),
  };
  return facts;
}
