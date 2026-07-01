import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/adjust/import/apply { rows: [{product_id, target, memo?}] }
//  현재고를 다시 확인해 델타(=target−current)를 재계산 후 '조정' 원장 일괄 기록. 델타 0은 건너뜀.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: { product_id?: string; target?: number; memo?: string | null }[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const sb = supabaseAdmin();
    const tr = await sb.rpc("inventory_stock", { asof: null });
    if (tr.error) throw tr.error;
    const stock = new Map<string, number>();
    for (const t of (tr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);

    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const insert: Record<string, unknown>[] = [];
    for (const r of rows) {
      if (!r || !r.product_id || r.target == null) continue;
      const target = Math.round(Number(r.target));
      if (!Number.isFinite(target) || target < 0) continue;
      const delta = target - (stock.get(r.product_id) || 0);
      if (delta === 0) continue;
      insert.push({ product_id: r.product_id, type: "조정", qty: delta, txn_date: today, memo: (r.memo ? String(r.memo).slice(0, 500) : "엑셀 실사 조정"), created_by: actor });
    }
    if (!insert.length) return NextResponse.json({ ok: true, applied: 0, note: "변경할 재고가 없습니다(현재고와 실사수량 동일)." });

    const { error } = await sb.from("inventory_txns").insert(insert);
    if (error) throw error;
    return NextResponse.json({ ok: true, applied: insert.length });
  } catch (err) {
    console.error("[inventory/adjust/import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조정 반영 실패") }, { status: 500 });
  }
}
