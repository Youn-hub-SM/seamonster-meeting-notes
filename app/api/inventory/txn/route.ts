import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { INV_TXN_TYPES, signedQty, type InvTxnType } from "@/app/lib/inventory";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// POST { product_id, type, qty, unit_amount?, txn_date?, partner?, memo? } — 입고/출고/조정 기록.
//  입고/출고는 qty 양수(수량), 조정은 부호 있는 델타(목표수량-현재수량을 UI 에서 계산해 전달).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const product_id = String(b.product_id || "");
    const type = String(b.type || "") as InvTxnType;
    if (!product_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (!INV_TXN_TYPES.includes(type)) return NextResponse.json({ ok: false, error: "유형이 올바르지 않습니다." }, { status: 400 });
    const qty = signedQty(type, Number(b.qty) || 0);
    if (qty === 0) return NextResponse.json({ ok: false, error: "수량을 입력하세요." }, { status: 400 });
    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : undefined;

    const sb = supabaseAdmin();
    const row: Record<string, unknown> = {
      product_id, type, qty,
      unit_amount: b.unit_amount === undefined || b.unit_amount === "" || b.unit_amount === null ? null : Math.max(0, Math.round(Number(b.unit_amount) || 0)),
      partner: String(b.partner || "").trim() || null,
      memo: String(b.memo || "").trim() || null,
      created_by: await actor(req),
    };
    if (txn_date) row.txn_date = txn_date;
    // 입고/출고 단건도 주문번호 부여(033 미적용이면 생략).
    if (type === "입고" || type === "출고") {
      try {
        const { data, error } = await sb.rpc("next_inventory_order_no", { p_type: type });
        if (!error && data) { row.group_id = crypto.randomUUID(); row.order_no = String(data); }
      } catch { /* 033 미적용 */ }
    }

    const { data, error } = await sb.from("inventory_txns").insert(row).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, txn: data });
  } catch (err) {
    console.error("[inventory/txn POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "기록 실패") }, { status: 500 });
  }
}

// DELETE ?id= — 거래 취소(원장에서 삭제 = 현재고 원복)
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("inventory_txns").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/txn DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
