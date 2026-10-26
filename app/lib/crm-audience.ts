// CRM 메시지의 '그 주 대상자 수' 추정(2026-10-27, 대표: "발송 수를 매번 입력하는 건 무리 — 업무도우미 기반으로").
//  트리거 + D+n + 고객군으로 매출 원장(sales_orders)에서 센다. 실제 발송(카카오채널 친구·수신 동의 필터)보다 많게 나오므로 '추정'으로 표시.
//  장바구니 이탈·가입·행사·상시는 우리 데이터에 없어 null(직접 입력 또는 비움).
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSql } from "./analyst";

export type AudienceResult = { count: number | null; basis: "estimate"; note: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 고객군(crm_messages.customer) → 매출 원장 channel 조건. 값은 정규식으로(채널 표기가 '공식몰'·'카페24'·'스마트스토어' 등 섞여 있어도 잡히게)
const CHANNEL_SQL: Record<string, string> = {
  mall: `channel ~ '공식|카페24|cafe24|자사'`,
  naver: `channel ~ '네이버|스마트|톡스토어|naver|smartstore'`,
};
const chanWhere = (customer: string) => (CHANNEL_SQL[customer] ? ` and ${CHANNEL_SQL[customer]}` : "");

const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// week = 월요일, until = 일요일. 메시지가 '트리거 D+n' 이면, 그 주에 발송된 대상 = 트리거가 (week-n)~(until-n) 에 일어난 고객.
export async function estimateAudience(sb: SupabaseClient, m: { trigger: string; offset_days: number | null; customer: string; offset_note?: string }, week: string, until: string): Promise<AudienceResult> {
  if (!DATE_RE.test(week) || !DATE_RE.test(until)) return { count: null, basis: "estimate", note: "기간 오류" };
  const n = Number.isFinite(Number(m.offset_days)) ? Math.trunc(Number(m.offset_days)) : 0;
  const from = shift(week, -n), to = shift(until, -n);
  const cw = chanWhere(m.customer);
  let q = "";
  let note = "";
  switch (m.trigger) {
    case "first_order":
      // 고객 키의 첫 주문일이 창 안 — 주문 단위(order_unit) 기준 첫 건
      q = `with f as (select customer_key, min(order_date) d from sales_orders where customer_key <> '' ${cw} group by customer_key) select count(*)::int n from f where d between '${from}' and '${to}'`;
      note = `첫 주문 ${from}~${to}`;
      break;
    case "reorder": {
      // 두 번째 이상 주문이 창 안(2회·3회 조건은 offset_note 에 숫자가 있으면 그 횟수 정확히)
      const k = Number((m.offset_note || "").match(/(\d+)\s*회/)?.[1]);
      const having = k >= 2 ? `= ${k}` : ">= 2";
      q = `with o as (select customer_key, order_unit, min(order_date) d from sales_orders where customer_key <> '' ${cw} group by customer_key, order_unit), r as (select customer_key, d, row_number() over (partition by customer_key order by d) rn from o) select count(*)::int n from r where rn ${having} and d between '${from}' and '${to}'`;
      note = `${k >= 2 ? `${k}회째` : "재"}구매 ${from}~${to}`;
      break;
    }
    case "shipped":
    case "delivered":
      // 출고일이 없는 원장이라 주문일로 근사(출고 = 주문 +1일, 배송 완료 = 주문 +2일 가정)
      q = `select count(distinct order_unit)::int n from sales_orders where order_date between '${shift(from, m.trigger === "shipped" ? -1 : -2)}' and '${shift(to, m.trigger === "shipped" ? -1 : -2)}' ${cw}`;
      note = `${m.trigger === "shipped" ? "출고(주문+1일 가정)" : "배송 완료(주문+2일 가정)"} ${from}~${to}`;
      break;
    case "inactive":
      // 마지막 주문일이 정확히 n일 전인 고객 — 그 주 7일 합
      q = `with l as (select customer_key, max(order_date) d from sales_orders where customer_key <> '' ${cw} group by customer_key) select count(*)::int n from l where d between '${from}' and '${to}'`;
      note = `마지막 구매 ${from}~${to} (${n}일 경과)`;
      break;
    case "subscription":
      // 정기배송: 카페24 정기배송 동기화(127) 의 '이용중'(state U) 신청 수 — 회차별 마감이 매주 다 오진 않으니 상한 근사
      q = `select count(*)::int n from cafe24_subscriptions where state = 'U'`;
      note = "이용중 정기배송 신청 수(상한)";
      break;
    default:
      return { count: null, basis: "estimate", note: m.trigger ? "우리 데이터로 셀 수 없는 트리거" : "트리거 없음" };
  }
  try {
    const rows = await runSql<{ n: number }>(sb, q, 1);
    return { count: Number(rows[0]?.n) || 0, basis: "estimate", note };
  } catch (e) {
    return { count: null, basis: "estimate", note: `추정 실패: ${e instanceof Error ? e.message.slice(0, 80) : "오류"}` };
  }
}
