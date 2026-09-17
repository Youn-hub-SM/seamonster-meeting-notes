import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getLeadDays, getCycleDays } from "@/app/lib/production-config";
import { getPromoForwardBySku } from "@/app/lib/production-promotions";
import { getAllBundles, bundleAvailable } from "@/app/lib/product-bundles";
import { getOpenInboundByProduct, formatInbound, type InboundRow } from "@/app/lib/production-inbound";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KST_TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const daysInclusive = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400_000) + 1);

export type OverviewRow = {
  product_id: string; sku: string | null; name: string; spec: string | null; unit: string;
  attrs: string | null; // 속성/분류(상품마스터 자유 입력) — 재고 목록 검색용
  qty: number; cost_price: number; value: number;
  period_in: number; period_out: number; daily_out: number;
  auto_safety: number; promo_qty: number; depletion_days: number | null; low: boolean;
  promo_pool: number; // 프로모션 풀 잔량(113) — 소매 탭에서 현재고 옆 병기, 그 외 채널은 0
  inbound: number;    // 오는 중 = 열린 제조사 요청서 잔여(소매·전체 탭) — 부족 판정·권장 수식이 현재고에 더해 본다. 도매 탭은 0
  inbound_due: string | null; // 잔여가 있는 요청서 중 가장 이른 마감
  inbound_detail: string;     // 툴팁용 요청서별 내역("PR-000123 300 (마감 09-25)")
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
    const chan = chanParam === "도매" || chanParam === "소매" || chanParam === "프로모션" ? chanParam : null;
    const periodDays = daysInclusive(from, to);

    const sb = supabaseAdmin();
    const [leadDays, cycleDays] = await Promise.all([getLeadDays(), getCycleDays()]);
    const horizonDays = leadDays + cycleDays; // 안전재고 지평 = 리드타임 + 발주 주기(권장 수식과 동일)

    const stockRpc = async () => {
      if (chan) { const r = await sb.rpc("inventory_stock", { asof: null, chan }); if (!r.error) return r; }
      return sb.rpc("inventory_stock", { asof: null });
    };
    const [pr, sr, promoFwd, bundles] = await Promise.all([
      sb.from("products").select("id, sku, name, spec, unit, cost_price, attrs").eq("active", true).order("name", { ascending: true }),
      stockRpc(),
      getPromoForwardBySku(today, horizonDays),
      getAllBundles(sb),
    ]);
    if (pr.error) throw pr.error;
    if (sr.error) throw sr.error;

    const stock = new Map<string, number>();
    for (const t of (sr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);
    const stockOf = (id: string) => stock.get(id) || 0;

    // 소매 탭: 프로모션 풀 잔량을 별도 필드로 병기(113) — 권장 수식(getInventoryRows)이 풀을 현재고로
    //  합산하므로, 부족(low) 판정도 소매+풀 기준으로 맞춰야 '부족인데 권장 0' 모순이 안 생긴다(검증 확정).
    const promoPool = new Map<string, number>();
    if (chan === "소매") {
      try {
        const pp = await sb.rpc("inventory_stock", { asof: null, chan: "프로모션" });
        if (!pp.error) for (const t of (pp.data as { product_id: string; qty: number }[] | null) ?? []) promoPool.set(t.product_id, Number(t.qty) || 0);
      } catch { /* 113 미적용 — 병기 없음 */ }
    }

    // 오는 중(열린 제조사 요청서 잔여) — 소매·전체 탭에서 현재고 옆 병기 + 부족(low) 판정에 합산.
    //  권장 수식(getInventoryRows)이 같은 값을 현재고에 더해 빼므로, 여기서도 더해야 '부족인데 권장 0' 모순이 없다.
    //  도매 탭은 제조사 입고 대상이 아니라 0. 집계 실패(null)면 0 으로 두고 meta.inboundOk=false 로 알린다.
    let inbound: Map<string, InboundRow> | null = new Map();
    if (chan !== "도매") inbound = await getOpenInboundByProduct(sb, today);
    const inboundOk = inbound !== null;

    // 기간 원장(입고/출고). channel(036) 컬럼 없으면 전체로 폴백.
    //  ※ 단발 .limit(20000)은 서버 Max Rows(기본 1000)가 우선해 조용히 잘린다 — 30일 총입고/총출고가
    //    실제보다 적게 나오던 원인(2026-09-03 대표 보고). range 페이징으로 전량 읽는다(안정 정렬 필수).
    type TxnRow = { product_id: string; type: string; qty: number; status?: string | null; partner?: string | null };
    const fetchTxns = async (withChannel: boolean): Promise<TxnRow[]> => {
      const out: TxnRow[] = [];
      for (let i = 0; i < 100000; i += 1000) {
        let q = sb.from("inventory_txns")
          .select(`product_id, type, qty, status, partner${withChannel ? ", channel" : ""}`)
          .in("type", ["입고", "출고"])
          .gte("txn_date", from).lte("txn_date", to)
          .order("id", { ascending: true })
          .range(i, i + 999);
        if (withChannel && chan) q = q.eq("channel", chan);
        const { data, error } = await q;
        if (error) throw error;
        out.push(...((data ?? []) as unknown as TxnRow[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    };
    let txRows: TxnRow[];
    try {
      txRows = await fetchTxns(true);
    } catch (e) {
      const msg = String((e as { message?: unknown })?.message ?? e);
      if (/channel/i.test(msg)) txRows = await fetchTxns(false); // 036 미적용 폴백
      else throw e;
    }

    const inq = new Map<string, number>();
    const outq = new Map<string, number>();
    for (const t of txRows) {
      if (t.status != null && t.status !== "완료") continue; // 대기 제외
      const q = Math.abs(Number(t.qty) || 0);
      if (t.type === "입고") inq.set(t.product_id, (inq.get(t.product_id) || 0) + q);
      else if (t.type === "출고") {
        // 채널이동(소매↔도매 내부 이동)은 판매가 아니다 — 총출고·일평균 소진·자동 안전재고에서 제외
        //  (판매속도 lib getLedgerVelocity 와 같은 규칙. 총입고의 이동분은 그대로 둔다 — 대표 지시는 출고.)
        if (t.partner === "채널이동") continue;
        outq.set(t.product_id, (outq.get(t.product_id) || 0) + q);
      }
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
      const auto_safety = Math.ceil(daily_out * horizonDays) + Math.round(promo);
      const depletion_days = daily_out > 0 ? Math.floor(qty / daily_out) : null;
      const inb = inbound?.get(p.id);
      const inbQty = inb?.qty ?? 0;
      return {
        product_id: p.id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, attrs: (p as { attrs?: string | null }).attrs ?? null,
        qty, cost_price: cost, value: qty * cost,
        period_in, period_out, daily_out: Math.round(daily_out * 10) / 10,
        auto_safety, promo_qty: Math.round(promo), depletion_days,
        promo_pool: Math.round((promoPool.get(p.id) || 0) * 100) / 100, // 프로모션 풀 잔량(소매 탭 병기용)
        inbound: inbQty, inbound_due: inb?.earliest_due ?? null, inbound_detail: formatInbound(inb, today),
        // 부족 = 현재고 + 프로모션 풀 + 오는 중이 안전재고 이하(권장 수식과 같은 재고 포지션 기준)
        low: auto_safety > 0 && qty + (promoPool.get(p.id) || 0) + inbQty <= auto_safety,
        is_bundle: isBundle,
      };
    });

    return NextResponse.json({ ok: true, rows, meta: { from, to, periodDays, leadDays, cycleDays, horizonDays, inboundOk } });
  } catch (err) {
    console.error("[inventory/overview]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 개요 조회 실패") }, { status: 500 });
  }
}
