import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { customerKey, normalizePhoneDigits, formatPhone } from "@/app/lib/sales-normalize";
import { salesOrIlike } from "@/app/lib/sales-filter";
import { logPhoneLookup } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LINE_COLS = "order_date,channel,order_id,product_name,option_name,sku_code,quantity,subtotal_amount";
const LIMIT = 300;

// 주문 검색. mode: phone(구매/재구매 확인) | order(주문번호) | text(상품·SKU·주문번호 like) + 기간·채널 필터.
export async function GET(req: NextRequest) {
  try {
    const p = new URL(req.url).searchParams;
    const phone = (p.get("phone") || "").trim();
    const orderId = (p.get("order_id") || "").trim();
    const text = (p.get("text") || "").trim();
    const from = p.get("from") || "", to = p.get("to") || "", channel = p.get("channel") || "";
    const sb = supabaseAdmin();

    // ── 1) 전화번호 → 고객 식별 → 구매이력 ──
    if (phone) {
      const digits = normalizePhoneDigits(phone);
      if (!digits) return NextResponse.json({ ok: false, error: "유효한 전화번호가 아니거나 마스킹된 번호입니다." }, { status: 400 });
      const key = customerKey(phone);
      const { data: cust } = await sb.from("sales_customers").select("phone,customer_name,first_seen_date,last_seen_date,order_count").eq("customer_key", key).maybeSingle();
      let q = sb.from("sales_orders").select(LINE_COLS).eq("customer_key", key).order("order_date", { ascending: false }).limit(LIMIT);
      if (from) q = q.gte("order_date", from);
      if (to) q = q.lte("order_date", to);
      const { data: lines, error } = await q;
      if (error) throw new Error(error.message);
      await logPhoneLookup(digits);
      const rows = lines || [];
      const orderIds = new Set(rows.map((r) => r.order_id));
      const revenue = rows.reduce((a, r) => a + Number(r.subtotal_amount || 0), 0);
      return NextResponse.json({
        ok: true, mode: "phone",
        customer: cust ? { phone: formatPhone(cust.phone), name: cust.customer_name, first_seen: cust.first_seen_date, last_seen: cust.last_seen_date, order_count: cust.order_count, is_repeat: Number(cust.order_count || 0) > 1 } : null,
        summary: { lines: rows.length, orders: orderIds.size, revenue, capped: rows.length >= LIMIT },
        rows,
      });
    }

    // ── 2) 주문번호 정확 매칭 ──
    if (orderId) {
      const { data: lines, error } = await sb.from("sales_orders").select(LINE_COLS).eq("order_id", orderId).order("order_date", { ascending: false }).limit(LIMIT);
      if (error) throw new Error(error.message);
      const rows = lines || [];
      return NextResponse.json({ ok: true, mode: "order", summary: { lines: rows.length, orders: rows.length ? 1 : 0, revenue: rows.reduce((a, r) => a + Number(r.subtotal_amount || 0), 0), capped: rows.length >= LIMIT }, rows });
    }

    // ── 3) 상품명·SKU·주문번호 부분검색(+기간·채널) ──
    if (text || from || to || channel) {
      let q = sb.from("sales_orders").select(LINE_COLS).order("order_date", { ascending: false }).limit(LIMIT);
      if (text) { const orf = salesOrIlike(text); if (orf) q = q.or(orf); }
      if (from) q = q.gte("order_date", from);
      if (to) q = q.lte("order_date", to);
      if (channel) q = q.eq("channel", channel);
      const { data: lines, error } = await q;
      if (error) throw new Error(error.message);
      const rows = lines || [];
      const orderIds = new Set(rows.map((r) => r.order_id));
      return NextResponse.json({ ok: true, mode: "text", summary: { lines: rows.length, orders: orderIds.size, revenue: rows.reduce((a, r) => a + Number(r.subtotal_amount || 0), 0), capped: rows.length >= LIMIT }, rows });
    }

    return NextResponse.json({ ok: false, error: "검색어를 입력하세요(전화번호·주문번호·상품명 중 하나)." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
