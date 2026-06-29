import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = {
  id: string; product_id: string; type: string; qty: number; unit_amount: number | null;
  txn_date: string; partner: string | null; memo: string | null; created_by: string | null; created_at: string;
  order_no?: string | null; group_id?: string | null; status?: string | null;
  products?: { name?: string; sku?: string | null } | null;
};

// GET /api/inventory/orders?type=&from=&to=&limit= — 입고/출고를 '주문(묶음)' 단위로 그룹핑.
//  group_id 로 묶고, 없으면 단건(자기 자신)으로. migration 033 미적용이면 order_no/group_id 없이 단건.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const type = sp.get("type");
    const from = sp.get("from");
    const to = sp.get("to");
    const limit = Math.min(4000, Math.max(1, Number(sp.get("limit")) || 1500));
    const sb = supabaseAdmin();

    const sel = (withGroup: boolean) => {
      let q = sb.from("inventory_txns")
        .select(`id, product_id, type, qty, unit_amount, txn_date, partner, memo, created_by, created_at${withGroup ? ", order_no, group_id, status" : ""}, products(name, sku)`)
        .in("type", ["입고", "출고"])
        .order("created_at", { ascending: false })
        .limit(limit);
      if (type === "입고" || type === "출고") q = q.eq("type", type);
      if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
      if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);
      return q;
    };

    let res = await sel(true);
    if (res.error) res = await sel(false); // 033 미적용 폴백
    if (res.error) throw res.error;
    const raws = (res.data ?? []) as unknown as Raw[];

    // group_id 로 묶기(없으면 id 단건)
    const map = new Map<string, ReturnType<typeof emptyOrder>>();
    function emptyOrder(r: Raw) {
      return {
        key: r.group_id || r.id, order_no: r.order_no || null, type: r.type, status: r.status || "완료",
        txn_date: r.txn_date, created_at: r.created_at, partner: r.partner, memo: r.memo, created_by: r.created_by,
        item_count: 0, total_qty: 0, total_amount: 0,
        items: [] as { id: string; product_name: string; sku: string | null; qty: number; unit_amount: number | null; amount: number }[],
      };
    }
    for (const r of raws) {
      const k = r.group_id || r.id;
      const o = map.get(k) || emptyOrder(r);
      const absQty = Math.abs(Number(r.qty) || 0);
      const amount = (Number(r.unit_amount) || 0) * absQty;
      o.items.push({ id: r.id, product_name: r.products?.name || "(삭제됨)", sku: r.products?.sku ?? null, qty: absQty, unit_amount: r.unit_amount, amount });
      o.item_count += 1; o.total_qty += absQty; o.total_amount += amount;
      if (!o.memo && r.memo) o.memo = r.memo;
      if (!o.partner && r.partner) o.partner = r.partner;
      map.set(k, o);
    }
    const orders = [...map.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return NextResponse.json({ ok: true, orders });
  } catch (err) {
    console.error("[inventory/orders GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "주문 조회 실패") }, { status: 500 });
  }
}

// PATCH { group_id?|id?, status } — 입고처리/출고처리(대기→완료) 등 상태 전환.
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as { group_id?: string; id?: string; status?: string };
    const status = b.status === "대기" ? "대기" : "완료";
    const sb = supabaseAdmin();
    let q = sb.from("inventory_txns").update({ status });
    if (b.group_id) q = q.eq("group_id", b.group_id);
    else if (b.id) q = q.eq("id", b.id);
    else return NextResponse.json({ ok: false, error: "group_id 또는 id 가 필요합니다." }, { status: 400 });
    const { error } = await q;
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/orders PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}

// DELETE ?group_id= | ?id= — 주문(묶음) 전체 취소, 또는 단건.
export async function DELETE(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const groupId = sp.get("group_id");
    const id = sp.get("id");
    const sb = supabaseAdmin();
    if (groupId) {
      const { error } = await sb.from("inventory_txns").delete().eq("group_id", groupId);
      if (error) throw error;
    } else if (id) {
      const { error } = await sb.from("inventory_txns").delete().eq("id", id);
      if (error) throw error;
    } else {
      return NextResponse.json({ ok: false, error: "group_id 또는 id 가 필요합니다." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/orders DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
