import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getBoxheroToken, fetchBoxheroItems } from "@/app/lib/boxhero";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/import — 박스히어로 현재고를 SKU 기준으로 끌어와 기초재고(조정)로 맞춘다.
//  현재고가 박스히어로 수량이 되도록 delta(=박스히어로수량-현재수량) 만큼 '조정' 한 줄 기록. 재실행 안전(다시 동기화).
export async function POST(req: NextRequest) {
  try {
    const token = await getBoxheroToken();
    if (!token) return NextResponse.json({ ok: false, error: "박스히어로 토큰이 없습니다. 설정에서 먼저 등록하세요." }, { status: 400 });
    const sb = supabaseAdmin();
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const [items, pr, tr] = await Promise.all([
      fetchBoxheroItems(token),
      sb.from("products").select("id, sku").eq("active", true),
      sb.from("inventory_txns").select("product_id, qty"),
    ]);
    if (pr.error) throw pr.error;
    if (tr.error) throw tr.error;

    // SKU → product_id
    const bySku = new Map<string, string>();
    for (const p of pr.data ?? []) if (p.sku) bySku.set(String(p.sku).trim(), p.id);
    // 현재고
    const cur = new Map<string, number>();
    for (const t of tr.data ?? []) cur.set(t.product_id, (cur.get(t.product_id) || 0) + (Number(t.qty) || 0));

    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const rows: Record<string, unknown>[] = [];
    let matched = 0, unmatched = 0;
    for (const it of items) {
      const sku = it.sku ? String(it.sku).trim() : "";
      const pid = sku ? bySku.get(sku) : undefined;
      if (!pid) { unmatched++; continue; }
      matched++;
      const delta = (Number(it.quantity) || 0) - (cur.get(pid) || 0);
      if (delta === 0) continue;
      rows.push({ product_id: pid, type: "조정", qty: delta, txn_date: today, memo: "박스히어로 기초재고 동기화", created_by: actor });
    }
    if (rows.length) {
      const { error } = await sb.from("inventory_txns").insert(rows);
      if (error) throw error;
    }
    return NextResponse.json({ ok: true, boxheroItems: items.length, matched, unmatched, applied: rows.length });
  } catch (err) {
    console.error("[inventory/import POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "기초재고 가져오기 실패") }, { status: 500 });
  }
}
