import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { signedQty } from "@/app/lib/inventory";
import { getAllBundles, expandBundleQty } from "@/app/lib/product-bundles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Item = { sku: string; qty: number; orderDate?: string | null };
type ProductRow = { productId: string; name: string; option: string; need: number; current: number; after: number; short: boolean };
type ItemRow = { sku: string; name: string; qty: number; kind: "single" | "bundle" | "unmatched" | "ambiguous" };

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 중복 검사 서명 — SKU별 '합산' 수량 기준(주문일 분해와 무관). 기존(분해 전) 서명과도 동일해 연속성 유지.
function sigOf(items: Item[]): string {
  const merged = new Map<string, number>();
  for (const i of items) { const k = i.sku.trim().toUpperCase(); merged.set(k, (merged.get(k) || 0) + Math.round(i.qty)); }
  const norm = [...merged.entries()].map(([k, q]) => `${k}:${q}`).sort().join("|");
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

// 주문일(L열 파싱값) 검증 — 형식 불량·미래·과도한 과거(14일 초과)는 처리일 폴백(재고 시점 왜곡 방지).
function validOrderDate(v: string | null | undefined, today: string): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  if (v > today) return null;
  const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 14);
  if (v < d.toISOString().slice(0, 10)) return null;
  return v;
}

// POST { items:[{sku,qty}], commit?, force? }
//  commit=false → 미리보기(재고 확인). commit=true → 소매 출고 일괄 기록. force=true → 중복(sig) 무시.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { items?: Item[]; commit?: boolean; force?: boolean };
    const todayKst = kstToday();
    const items = (body.items || [])
      .filter((i) => i && i.sku && Number(i.qty) > 0)
      .map((i) => ({ sku: String(i.sku).trim(), qty: Math.round(Number(i.qty)), orderDate: validOrderDate(i.orderDate, todayKst) }));
    if (!items.length) return NextResponse.json({ ok: false, error: "출고할 품목이 없습니다." }, { status: 400 });
    const commit = !!body.commit;
    const sb = supabaseAdmin();

    // 상품 맵(대문자 SKU) + 묶음. spec = 옵션.
    const { data: prods, error: pErr } = await sb.from("products").select("id, sku, name, spec").not("sku", "is", null);
    if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    const bySku = new Map<string, { id: string; name: string }[]>();
    const nameById = new Map<string, string>();
    const optById = new Map<string, string>();
    for (const p of (prods || []) as { id: string; sku: string; name: string; spec?: string }[]) {
      const k = String(p.sku || "").trim().toUpperCase();
      nameById.set(p.id, p.name || "");
      optById.set(p.id, p.spec || "");
      if (!k) continue;
      const a = bySku.get(k) || []; a.push({ id: p.id, name: p.name || "" }); bySku.set(k, a);
    }
    const bundles = await getAllBundles(sb);

    // 아이템 해석 + 묶음 전개 → product_id별 수량(전체 합 = 재고 확인용) + 주문일별 수량(출고 기록용).
    //  출고 txn 은 '주문일' 축으로 기록해 매출(주문일자)과 같은 축에서 완전 대조 — 주문일 없으면 처리일.
    const perProduct = new Map<string, number>();
    const perDateProduct = new Map<string, Map<string, number>>(); // 주문일("" = 처리일) → product_id → qty
    const itemRows: ItemRow[] = [];
    for (const it of items) {
      const m = bySku.get(it.sku.toUpperCase());
      if (!m || !m.length) { itemRows.push({ sku: it.sku, name: "", qty: it.qty, kind: "unmatched" }); continue; }
      if (m.length > 1) { itemRows.push({ sku: it.sku, name: m[0].name, qty: it.qty, kind: "ambiguous" }); continue; }
      const p = m[0];
      const isBundle = (bundles.get(p.id)?.length || 0) > 0;
      expandBundleQty(bundles, p.id, it.qty, perProduct); // 공용 전개 규칙
      const dk = it.orderDate || "";
      const dm = perDateProduct.get(dk) || new Map<string, number>();
      expandBundleQty(bundles, p.id, it.qty, dm);
      perDateProduct.set(dk, dm);
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
      return { productId: pid, name: nameById.get(pid) || "", option: optById.get(pid) || "", need, current, after: current - need, short: current - need < 0 };
    }).sort((a, b) => a.name.localeCompare(b.name, "ko") || a.option.localeCompare(b.option, "ko")); // 가나다순
    const shortages = productRows.filter((r) => r.short).length;

    if (!commit) return NextResponse.json({ ok: true, committed: false, items: itemRows, products: productRows, shortages });

    // ── 커밋 ──
    const sig = sigOf(items); const today = kstToday();
    if (!body.force) {
      try {
        // 같은 배치(SKU·수량 조합)를 다른 날 재업로드해도 이중차감을 막도록 '오늘'이 아니라 최근 7일로 검사.
        //  (지연·재작업으로 이튿날 같은 엑셀을 다시 올리는 경우가 실제 이중출고 원인) 재출고가 정말 필요하면 force.
        const since = new Date(Date.now() + 9 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10);
        const { data: dup } = await sb.from("fulfill_dispatch").select("order_no, dispatch_date").eq("sig", sig).gte("dispatch_date", since).order("dispatch_date", { ascending: false }).limit(1).maybeSingle();
        if (dup) return NextResponse.json({ ok: false, error: `이미 최근 출고된 발주입니다(${dup.dispatch_date}, 출고번호 ${dup.order_no}). 같은 배치가 다시 출고되려 합니다 — 정말 재출고하려면 강제 출고를 선택하세요.`, duplicate: true }, { status: 409 });
      } catch { /* 065 미적용 시 스킵 */ }
    }

    let orderNo = "";
    try { const { data } = await sb.rpc("next_inventory_order_no", { p_type: "출고" }); orderNo = String(data || ""); } catch { /* 033 미적용 */ }
    const groupId = crypto.randomUUID();
    type TxnRow = { product_id: string; type: string; qty: number; channel?: string; status?: string; group_id: string; order_no: string | null; partner: string; memo: string; txn_date: string };
    // 주문일별로 분해 기록 — 매출(주문일자)과 같은 축. 주문일 없는 행("")은 처리일로.
    let rows: TxnRow[] = [];
    for (const [dk, dm] of perDateProduct) {
      const txnDate = dk || today;
      const memo = dk && dk !== today ? `온라인발주 출고 ${today} (주문일 ${dk})` : `온라인발주 출고 ${today}`;
      for (const [pid, q] of dm) {
        if (q <= 0) continue;
        rows.push({ product_id: pid, type: "출고", qty: signedQty("출고", q), channel: "소매", status: "완료", group_id: groupId, order_no: orderNo || null, partner: "온라인몰", memo, txn_date: txnDate });
      }
    }
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
