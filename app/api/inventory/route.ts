import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getAllBundles } from "@/app/lib/product-bundles";
import { toInvChannelParam, type InventoryRow } from "@/app/lib/inventory";
import { getUntracked } from "@/app/lib/stock-tracked";
import { readAll, readStockMap } from "@/app/lib/inventory-template";
import { kstTodayIso } from "@/app/lib/production-schedule";

export const dynamic = "force-dynamic";

// GET /api/inventory[?asof=YYYY-MM-DD&channel=] — 품목 + 재고(Σ txn.qty, 완료) + 안전재고.
//  asof 지정 시 그 날짜까지의 누적 수량(과거 수량 조회). 제품목록·부족알림·과거조회 공용.
//  asof 없으면 qty = 전체 원장(미래 발송일 선점까지 뺀 가용 — 이동·출고 경고의 기준, 종전과 같음)이고,
//  on_hand = 오늘(KST)까지(현재고), scheduled_out = on_hand − qty(출고 예정)를 함께 싣는다(S6).
export async function GET(req: NextRequest) {
  try {
    const asof = req.nextUrl.searchParams.get("asof");
    const chanParam = req.nextUrl.searchParams.get("channel");
    const chan = toInvChannelParam(chanParam); // '전체'·빈값·모르는 값 → null = 전 칸 합산
    const sb = supabaseAdmin();
    const asofParam = asof && /^\d{4}-\d{2}-\d{2}$/.test(asof) ? asof : null;
    // 매입단가·원산지·속성은 migration 032 컬럼 — 미적용 환경에선 기본 컬럼으로 폴백(재고 페이지 안 죽게).
    //  페이지 끝까지 읽는다 — 단발 조회는 1000행에서 잘린다(S4).
    type P = { id: string; sku: string | null; name: string; spec: string | null; unit: string; cost_price: number; purchase_price?: number; origin?: string | null; attrs?: string | null };
    const productsQ = async () => {
      const page = (cols: string) => readAll<P>((a, b) => sb.from("products").select(cols).eq("active", true)
        .order("name", { ascending: true }).order("id", { ascending: true }).range(a, b));
      try { return await page("id, sku, name, spec, unit, cost_price, purchase_price, origin, attrs"); }
      catch { return page("id, sku, name, spec, unit, cost_price"); }
    };
    type I = { product_id: string; min_qty: number; barcode: string | null; location: string | null };
    const [products, qtyMap, todayMap, items, bundles, untracked] = await Promise.all([
      productsQ(),
      // 채널 지정 시 inventory_stock(asof, chan). 036 미적용(PGRST202)일 때만 전체로 폴백 — 다른 오류는 던진다(감사 #11)
      readStockMap(sb, { asof: asofParam, chan }),
      asofParam ? Promise.resolve(null) : readStockMap(sb, { asof: kstTodayIso(), chan }),
      readAll<I>((a, b) => sb.from("inventory_items").select("product_id, min_qty, barcode, location").order("product_id", { ascending: true }).range(a, b)),
      getAllBundles(sb), // 부모 product_id → 구성품[] (037 미적용이면 빈 맵 → is_bundle 전부 false, 그 밖의 오류는 던진다)
      getUntracked(sb), // '재고 관리 사용 안함'(121) — 입고 및 출고·조정·과거 수량·재고 이동 품목에서 뺀다
    ]);

    const itemMap = new Map<string, { min_qty: number; barcode: string | null; location: string | null }>();
    for (const it of items) itemMap.set(it.product_id, { min_qty: Number(it.min_qty) || 0, barcode: it.barcode, location: it.location });

    const rows: InventoryRow[] = products.filter((p) => !untracked.ids.has(p.id)).map((p) => {
      const qty = qtyMap.get(p.id) || 0;
      const meta = itemMap.get(p.id) || { min_qty: 0, barcode: null, location: null };
      const cost = Number(p.cost_price) || 0;
      const onHand = todayMap ? todayMap.get(p.id) || 0 : null;
      return {
        product_id: p.id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit,
        cost_price: cost, purchase_price: Number(p.purchase_price) || 0,
        origin: p.origin ?? null, attrs: p.attrs ?? null,
        qty, min_qty: meta.min_qty, value: qty * cost,
        ...(onHand != null ? { on_hand: onHand, scheduled_out: Math.max(0, Math.round((onHand - qty) * 100) / 100) } : {}),
        barcode: meta.barcode, location: meta.location,
        low: meta.min_qty > 0 && qty <= meta.min_qty,
        is_bundle: bundles.has(p.id),
      };
    });
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[inventory GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 조회 실패") }, { status: 500 });
  }
}

// PATCH { product_id, min_qty?, barcode?, location?, memo? } — 품목 재고설정 upsert
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown> & { product_id?: string };
    if (!b.product_id) return NextResponse.json({ ok: false, error: "product_id 가 필요합니다." }, { status: 400 });
    const row: Record<string, unknown> = { product_id: b.product_id, updated_at: new Date().toISOString() };
    if (b.min_qty !== undefined) row.min_qty = Math.max(0, Math.round(Number(b.min_qty) || 0));
    if (b.barcode !== undefined) row.barcode = String(b.barcode || "").trim() || null;
    if (b.location !== undefined) row.location = String(b.location || "").trim() || null;
    if (b.memo !== undefined) row.memo = String(b.memo || "").trim() || null;
    const { error } = await supabaseAdmin().from("inventory_items").upsert(row, { onConflict: "product_id" });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
