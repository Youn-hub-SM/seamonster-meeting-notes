// VOC 주문번호 → 주문 확인(2026-10-26): 채널·주문일·상품과 그 고객의 주문 건수(재구매 여부).
//  고객 식별은 sales_orders.customer_key(HMAC) 로만 — 이름·연락처는 꺼내지 않는다(PII 격리 원칙).
import { supabaseAdmin } from "./supabase";

export type VocOrderInfo = {
  found: boolean;
  order_no: string;
  channel: string;
  order_date: string;      // YYYY-MM-DD
  product: string;         // 주문 상품명(여러 상품이면 첫 상품 + 외 N)
  orders: number;          // 이 고객의 전체 주문 건수(order_unit 기준). 고객 키 없으면 0
  repeat: boolean | null;  // 재구매 여부(주문 2건 이상). 고객 키 없으면 null
};

export const normalizeOrderNo = (s: unknown): string => String(s ?? "").trim().replace(/\s+/g, "").slice(0, 60);

export async function lookupVocOrder(orderNoRaw: unknown): Promise<VocOrderInfo> {
  const order_no = normalizeOrderNo(orderNoRaw);
  const none: VocOrderInfo = { found: false, order_no, channel: "", order_date: "", product: "", orders: 0, repeat: null };
  if (!order_no) return none;
  const sb = supabaseAdmin();
  type Row = { order_id: string; channel: string; order_date: string; product_name: string; customer_key: string };
  const sel = "order_id,channel,order_date,product_name,customer_key";
  // 하이픈·공백은 있어도 없어도 되게: 입력 그대로 / 하이픈 뺀 것 / 숫자 15자리면 카페24 꼴(YYYYMMDD-NNNNNNN) 후보를 한 번에 찾는다
  const digits = order_no.replace(/[^0-9A-Za-z]/g, "");
  const cands = new Set<string>([order_no, digits]);
  if (/^\d{15}$/.test(digits)) cands.add(`${digits.slice(0, 8)}-${digits.slice(8)}`);
  let { data, error } = await sb.from("sales_orders").select(sel).in("order_id", [...cands]).order("order_date", { ascending: true }).limit(20);
  if (error) throw error;
  let rows = (data || []) as Row[];
  // 그래도 없으면 부분 일치(앞뒤 일부만 넣은 경우) — 주문번호 하나로만 좁혀질 때 채택
  if (!rows.length && digits.length >= 6) {
    const r2 = await sb.from("sales_orders").select(sel).ilike("order_id", `%${digits}%`).order("order_date", { ascending: true }).limit(40);
    if (r2.error) throw r2.error;
    const all = (r2.data || []) as Row[];
    const ids = [...new Set(all.map((r) => r.order_id))];
    if (ids.length === 1) rows = all;
  }
  if (!rows.length) return none;
  const order_no_found = rows[0].order_id || order_no;
  const names = [...new Set(rows.map((r) => r.product_name).filter(Boolean))];
  const product = names.length > 1 ? `${names[0]} 외 ${names.length - 1}` : names[0] || "";
  const key = rows[0].customer_key || "";
  let orders = 0, repeat: boolean | null = null;
  if (key) {
    const { data: od, error: oe } = await sb.from("sales_orders").select("order_unit").eq("customer_key", key).limit(2000);
    if (oe) throw oe;
    orders = new Set(((od || []) as { order_unit: string | null }[]).map((r) => r.order_unit).filter(Boolean)).size;
    repeat = orders >= 2;
  }
  return { found: true, order_no: order_no_found, channel: rows[0].channel || "", order_date: rows[0].order_date || "", product, orders, repeat };
}

// 저장 직전 자동 채움 — 주문번호가 있고 찾으면 구매자 구분·구매일을 덮어쓴다(손으로 안 넣는 칸). 못 찾으면 건드리지 않는다.
export async function autoFillFromOrder(row: Record<string, unknown>): Promise<void> {
  if (typeof row.order_no !== "string" || !row.order_no.trim()) return;
  try {
    const o = await lookupVocOrder(row.order_no);
    if (!o.found) return;
    row.order_no = o.order_no;
    if (o.repeat !== null) row.buyer_type = o.repeat ? "재구매" : "첫구매";
    if (o.order_date) row.purchase_date = o.order_date;
  } catch (e) {
    console.warn("[voc] 주문 확인 실패 — 자동 채움 생략", e instanceof Error ? e.message : e);
  }
}
