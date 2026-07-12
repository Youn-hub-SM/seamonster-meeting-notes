import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { signedQty } from "@/app/lib/inventory";
import { getAllBundles } from "@/app/lib/product-bundles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Item = { sku: string; qty: number };
type ProductRow = { productId: string; name: string; need: number; current: number; after: number; short: boolean };
type ItemRow = { sku: string; name: string; qty: number; kind: "single" | "bundle" | "unmatched" | "ambiguous" };

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
function sigOf(items: Item[]): string {
  const norm = items.map((i) => `${i.sku.trim().toUpperCase()}:${Math.round(i.qty)}`).sort().join("|");
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

// POST { items:[{sku,qty}], commit?, force? }
//  commit=false → 미리보기(재고 확인). commit=true → 소매 출고 일괄 기록. force=true → 중복(sig) 무시.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { items?: Item[]; commit?: boolean; force?: boolean };
    const items = (body.items || [])
      .filter((i) => i && i.sku && Number(i.qty) > 0)
      .map((i) => ({ sku: String(i.sku).trim(), qty: Math.round(Number(i.qty)) }));
    if (!items.length) return NextResponse.json({ ok: false, error: "출고할 품목이 없습니다." }, { status: 400 });
    const commit = !!body.commit;
    const sb = supabaseAdmin();

    // 상품 맵(대문자 SKU) + 묶음
    const { data: prods, error: pErr } = await sb.from("products").select("id, sku, name").not("sku", "is", null);
    if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    const bySku = new Map<string, { id: string; name: string }[]>();
    const nameById = new Map<string, string>();
    for (const p of prods || []) {
      const k = String(p.sku || "").trim().toUpperCase();
      nameById.set(p.id, p.name || "");
      if (!k) continue;
      const a = bySku.get(k) || []; a.push({ id: p.id, name: p.name || "" }); bySku.set(k, a);
    }
    const bundles = await getAllBundles(sb);

    // 아이템 해석 + 묶음 전개 → product_id별 수량
    const perProduct = new Map<string, number>();
    const itemRows: ItemRow[] = [];
    const expand = (pid: string, qty: number, depth: number) => {
      const comps = bundles.get(pid);
      if (comps && comps.length && depth < 8) { for (const c of comps) expand(c.component_id, qty * c.qty, depth + 1); return; }
      perProduct.set(pid, (perProduct.get(pid) || 0) + qty);
    };
    for (const it of items) {
      const m = bySku.get(it.sku.toUpperCase());
      if (!m || !m.length) { itemRows.push({ sku: it.sku, name: "", qty: it.qty, kind: "unmatched" }); continue; }
      if (m.length > 1) { itemRows.push({ sku: it.sku, name: m[0].name, qty: it.qty, kind: "ambiguous" }); continue; }
      const p = m[0];
      const isBundle = (bundles.get(p.id)?.length || 0) > 0;
      expand(p.id, it.qty, 0);
      itemRows.push({ sku: it.sku, name: p.name, qty: it.qty, kind: isBundle ? "bundle" : "single" });
    }

    const productIds = [...perProduct.keys()];
    if (!productIds.length) return NextResponse.json({ ok: true, committed: false, items: itemRows, products: [], shortages: 0, message: "매칭된(출고 가능) 품목이 없습니다." });

    // 현재 소매 재고(완료) — product_id별 합. 채널/상태 컬럼 미적용 환경 폴백.
    type Tx = { product_id: string; qty: number };
    let txns: Tx[] = [];
    {
      const r1 = await sb.from("inventory_txns").select("product_id, qty").in("product_id", productIds).eq("status", "완료").eq("channel", "소매");
      if (r1.error && /channel/i.test(r1.error.message)) {
        const r2 = await sb.from("inventory_txns").select("product_id, qty").in("product_id", productIds).eq("status", "완료");
        if (r2.error && /status/i.test(r2.error.message)) {
          const r3 = await sb.from("inventory_txns").select("product_id, qty").in("product_id", productIds);
          txns = (r3.data as Tx[]) || [];
        } else txns = (r2.data as Tx[]) || [];
      } else if (r1.error && /status/i.test(r1.error.message)) {
        const r3 = await sb.from("inventory_txns").select("product_id, qty").in("product_id", productIds);
        txns = (r3.data as Tx[]) || [];
      } else txns = (r1.data as Tx[]) || [];
    }
    const stockMap = new Map<string, number>();
    for (const t of txns) stockMap.set(t.product_id, (stockMap.get(t.product_id) || 0) + (Number(t.qty) || 0));

    const productRows: ProductRow[] = productIds.map((pid) => {
      const need = perProduct.get(pid) || 0; const current = stockMap.get(pid) || 0;
      return { productId: pid, name: nameById.get(pid) || "", need, current, after: current - need, short: current - need < 0 };
    }).sort((a, b) => a.after - b.after);
    const shortages = productRows.filter((r) => r.short).length;

    if (!commit) return NextResponse.json({ ok: true, committed: false, items: itemRows, products: productRows, shortages });

    // ── 커밋 ──
    const sig = sigOf(items); const today = kstToday();
    if (!body.force) {
      try {
        const { data: dup } = await sb.from("fulfill_dispatch").select("order_no").eq("sig", sig).eq("dispatch_date", today).maybeSingle();
        if (dup) return NextResponse.json({ ok: false, error: `이미 오늘 출고된 발주입니다(출고번호 ${dup.order_no}). 중복 출고를 막았습니다.`, duplicate: true }, { status: 409 });
      } catch { /* 065 미적용 시 스킵 */ }
    }

    let orderNo = "";
    try { const { data } = await sb.rpc("next_inventory_order_no", { p_type: "출고" }); orderNo = String(data || ""); } catch { /* 033 미적용 */ }
    const groupId = crypto.randomUUID();
    const memo = `온라인발주 출고 ${today}`;
    type TxnRow = { product_id: string; type: string; qty: number; channel?: string; status?: string; group_id: string; order_no: string | null; partner: string; memo: string; txn_date: string };
    let rows: TxnRow[] = productIds.map((pid) => ({ product_id: pid, type: "출고", qty: signedQty("출고", perProduct.get(pid) || 0), channel: "소매", status: "완료", group_id: groupId, order_no: orderNo || null, partner: "온라인몰", memo, txn_date: today }));
    let insErr = (await sb.from("inventory_txns").insert(rows)).error;
    if (insErr && /channel/i.test(insErr.message)) { rows = rows.map(({ channel, ...r }) => r); insErr = (await sb.from("inventory_txns").insert(rows)).error; }
    if (insErr && /status/i.test(insErr.message)) { rows = rows.map(({ status, ...r }) => r); insErr = (await sb.from("inventory_txns").insert(rows)).error; }
    if (insErr) return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });

    const totalQty = productRows.reduce((s, r) => s + r.need, 0);
    try { await sb.from("fulfill_dispatch").insert({ sig, dispatch_date: today, channel: "소매", sku_count: productIds.length, total_qty: totalQty, group_id: groupId, order_no: orderNo || null, created_by: "온라인발주" }); } catch { /* 065 미적용 스킵 */ }

    return NextResponse.json({ ok: true, committed: true, orderNo, groupId, items: itemRows, products: productRows, dispatched: productIds.length, totalQty, shortages });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "출고 실패") }, { status: 500 });
  }
}
