import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getLeadDays } from "@/app/lib/production-config";
import { getPromoForwardBySku } from "@/app/lib/production-promotions";
import { getAllBundles, bundleAvailable } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KST_TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const daysInclusive = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400_000) + 1);

export type OverviewRow = {
  product_id: string; sku: string | null; name: string; spec: string | null; unit: string;
  qty: number; cost_price: number; value: number;
  period_in: number; period_out: number; daily_out: number;
  auto_safety: number; promo_qty: number; depletion_days: number | null; low: boolean;
  is_bundle: boolean; // 묶음(세트) — 현재고는 '만들 수 있는 세트 수'(가용)
};

// GET /api/inventory/overview?from=&to=&channel= — 재고목록 고도화 뷰.
//  기간[from,to]의 총입고·총출고·일평균소진 + 자동 안전재고(일평균소진 × 리드타임 + 프로모션 확보분)
//  + 예상소진일수(현재고 ÷ 일평균소진). 채널(도매/소매) 지정 시 그 채널 기준.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const today = KST_TODAY();
    const to = DATE_RE.test(String(sp.get("to"))) ? String(sp.get("to")) : today;
    let from = DATE_RE.test(String(sp.get("from"))) ? String(sp.get("from")) : to;
    if (from > to) from = to;
    const chanParam = sp.get("channel");
    const chan = chanParam === "도매" || chanParam === "소매" ? chanParam : null;
    const periodDays = daysInclusive(from, to);

    const sb = supabaseAdmin();
    const leadDays = await getLeadDays();

    const stockRpc = async () => {
      if (chan) { const r = await sb.rpc("inventory_stock", { asof: null, chan }); if (!r.error) return r; }
      return sb.rpc("inventory_stock", { asof: null });
    };
    const [pr, sr, promoFwd, bundles] = await Promise.all([
      sb.from("products").select("id, sku, name, spec, unit, cost_price").eq("active", true).order("name", { ascending: true }),
      stockRpc(),
      getPromoForwardBySku(today, leadDays),
      getAllBundles(sb),
    ]);
    if (pr.error) throw pr.error;
    if (sr.error) throw sr.error;

    const stock = new Map<string, number>();
    for (const t of (sr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);
    const stockOf = (id: string) => stock.get(id) || 0;

    // 기간 원장(입고/출고). channel(036) 컬럼 없으면 전체로 폴백.
    const txnQ = (withChannel: boolean) => {
      let q = sb.from("inventory_txns")
        .select(`product_id, type, qty, status${withChannel ? ", channel" : ""}`)
        .in("type", ["입고", "출고"])
        .gte("txn_date", from).lte("txn_date", to)
        .limit(20000);
      if (withChannel && chan) q = q.eq("channel", chan);
      return q;
    };
    let tr = await txnQ(true);
    if (tr.error && /channel/i.test(tr.error.message)) tr = await txnQ(false);
    if (tr.error) throw tr.error;

    const inq = new Map<string, number>();
    const outq = new Map<string, number>();
    for (const t of (tr.data as unknown as { product_id: string; type: string; qty: number; status?: string | null }[] | null) ?? []) {
      if (t.status != null && t.status !== "완료") continue; // 대기 제외
      const q = Math.abs(Number(t.qty) || 0);
      if (t.type === "입고") inq.set(t.product_id, (inq.get(t.product_id) || 0) + q);
      else if (t.type === "출고") outq.set(t.product_id, (outq.get(t.product_id) || 0) + q);
    }

    const rows: OverviewRow[] = (pr.data ?? []).map((p) => {
      const comps = bundles.get(p.id);
      const isBundle = !!comps && comps.length > 0;
      // 묶음은 자체 재고 대신 '만들 수 있는 세트 수'(구성품 현재고 ÷ 구성수량의 최소값)
      const qty = isBundle ? bundleAvailable(comps!, stockOf) : (stock.get(p.id) || 0);
      const cost = Number(p.cost_price) || 0;
      const period_in = inq.get(p.id) || 0;
      const period_out = outq.get(p.id) || 0;
      const daily_out = period_out / periodDays;
      const promo = promoFwd[(p.sku || "").trim().toUpperCase()] || 0;
      const auto_safety = Math.ceil(daily_out * leadDays) + Math.round(promo);
      const depletion_days = daily_out > 0 ? Math.floor(qty / daily_out) : null;
      return {
        product_id: p.id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit,
        qty, cost_price: cost, value: qty * cost,
        period_in, period_out, daily_out: Math.round(daily_out * 10) / 10,
        auto_safety, promo_qty: Math.round(promo), depletion_days,
        low: auto_safety > 0 && qty <= auto_safety,
        is_bundle: isBundle,
      };
    });

    return NextResponse.json({ ok: true, rows, meta: { from, to, periodDays, leadDays } });
  } catch (err) {
    console.error("[inventory/overview]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 개요 조회 실패") }, { status: 500 });
  }
}
