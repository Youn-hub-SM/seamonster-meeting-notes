import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getManualProductions } from "@/app/lib/production-manual";
import { loadProdItemMaps } from "@/app/lib/production-items";

export const dynamic = "force-dynamic";

// GET /api/production/board
// 칸반 카드: B2B 발주(생산대기·생산중 전부 + 최근 14일 생산완료) + 수동 생산일정.
//  각 품목에 SKU·생산표시명(prodName)을 붙여, 품목별 보기에서 SKU로 묶을 수 있게 한다.

function kstTodayIso() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function addDaysIso(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

type ItemRow = { product_id: string | null; product_name: string; spec: string | null; qty: number; sort_order: number };
type OrderRow = {
  id: string; order_no: string; production_status: string; production_date: string | null;
  companies?: { name?: string } | { name?: string }[] | null;
  order_items?: ItemRow[];
};

export async function GET() {
  try {
    const today = kstTodayIso();
    const cutoff = addDaysIso(today, -14);
    const sb = supabaseAdmin();
    const sel = "id, order_no, production_status, production_date, companies:company_id(name), order_items(product_id, product_name, spec, qty, sort_order)";

    const [pendingRes, doneRes, maps] = await Promise.all([
      sb.from("orders").select(sel).in("production_status", ["생산대기", "생산중"]).order("production_date", { ascending: true }),
      sb.from("orders").select(sel).eq("production_status", "생산완료").gte("production_date", cutoff).order("production_date", { ascending: false }),
      loadProdItemMaps(),
    ]);
    if (pendingRes.error) throw pendingRes.error;
    if (doneRes.error) throw doneRes.error;

    const orderCards = ([...(pendingRes.data ?? []), ...(doneRes.data ?? [])] as unknown as OrderRow[]).map((o) => {
      const company = Array.isArray(o.companies) ? o.companies[0] : o.companies;
      const items = [...(o.order_items ?? [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((it) => {
          const sku = it.product_id ? maps.skuByProduct.get(it.product_id) || null : null;
          const prodName = sku ? maps.displayBySku.get(sku) || it.product_name : it.product_name;
          return { name: it.product_name, prodName, sku, spec: it.spec || "", qty: Number(it.qty) || 0 };
        });
      return {
        id: o.id,
        kind: "order" as const,
        status: o.production_status,
        company: company?.name ?? "(미지정)",
        orderNo: o.order_no,
        date: o.production_date,
        items,
      };
    });

    const manual = await getManualProductions();
    const manualCards = manual.map((m) => {
      const sku = (m.sku || "").toUpperCase() || null;
      const prodName = sku ? maps.displayBySku.get(sku) || m.name : m.name;
      return {
        id: m.id,
        kind: "manual" as const,
        status: m.status || "생산대기",
        company: "직접 추가",
        orderNo: null,
        date: m.productionDate,
        items: [{ name: m.name, prodName, sku, spec: "", qty: m.qty }],
      };
    });

    return NextResponse.json({ ok: true, today, cards: [...orderCards, ...manualCards] });
  } catch (err) {
    console.error("[production/board]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
