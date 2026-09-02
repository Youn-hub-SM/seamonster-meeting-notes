import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { fetchQuoteTxns, validMonth, monthRange } from "../quote/fetch";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// 그 달에 매입한 품목 + 매입수량.
async function purchasedProducts(month: string) {
  const txns = await fetchQuoteTxns(month);
  const hasStatus = txns.some((t) => t.status != null);
  const used = hasStatus ? txns.filter((t) => t.status === "완료") : txns;
  const m = new Map<string, { id: string; name: string; sku: string | null; spec: string | null; qty: number }>();
  for (const t of used) {
    const q = Math.abs(Math.round(Number(t.qty) || 0));
    if (!q) continue;
    const cur = m.get(t.product_id);
    if (cur) cur.qty += q;
    else m.set(t.product_id, {
      id: t.product_id, name: t.product?.name ?? "(삭제된 품목)",
      sku: t.product?.sku ?? null, spec: t.product?.spec ?? null, qty: q,
    });
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

// 품목 선택 목록 — 그 달 매입 품목(매입수량 표시) 뒤에 나머지 전체 품목(매입 0)을 붙인다.
//  그 달 매입이 없는 품목의 반품(교차월)도 입력할 수 있어야 한다(2026-09-02 대표 확정) —
//  결산이 그런 반품을 품목 행으로 추가해 차감한다.
async function selectableProducts(month: string) {
  const sb = supabaseAdmin();
  const purchased = await purchasedProducts(month);
  const map = new Map(purchased.map((p) => [p.id, p]));
  const [{ data }, bundles] = await Promise.all([
    sb.from("products").select("id, name, sku, spec").eq("active", true).limit(5000),
    getAllBundles(sb),
  ]);
  for (const p of data ?? []) {
    const id = p.id as string;
    if (map.has(id)) continue;
    if (isBundleId(bundles, id)) continue; // 번들(세트)은 자체 매입이 없다 — 반품 대상 아님
    map.set(id, { id, name: (p.name as string) ?? "", sku: (p.sku as string | null) ?? null, spec: (p.spec as string | null) ?? null, qty: 0 });
  }
  return [...map.values()].sort((a, b) =>
    (b.qty > 0 ? 1 : 0) - (a.qty > 0 ? 1 : 0) || a.name.localeCompare(b.name, "ko"));
}

// GET /api/inventory/returns?month=YYYY-MM — 그 달 반품 내역 + 매입 품목(선택 목록)
export async function GET(req: NextRequest) {
  try {
    const month = validMonth(req.nextUrl.searchParams.get("month"));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)가 필요합니다." }, { status: 400 });
    const { from, to } = monthRange(month);

    const [products, res] = await Promise.all([
      selectableProducts(month),
      supabaseAdmin().from("purchase_returns")
        .select("id, product_id, return_date, qty, unit_amount, partner, memo, products(name, sku, spec)")
        .gte("return_date", from).lte("return_date", to)
        .order("return_date", { ascending: false }).limit(2000),
    ]);
    // 087 미적용이면 테이블이 없다 — 화면이 죽지 않게 빈 목록으로 돌려주고 안내만 띄운다.
    if (res.error) {
      return NextResponse.json({ ok: true, rows: [], products, pending_migration: true });
    }

    type Join = { name?: string; sku?: string | null; spec?: string | null };
    const rows = (res.data ?? []).map((r) => {
      const p = (Array.isArray(r.products) ? r.products[0] : r.products) as Join | null;
      return {
        id: r.id as string,
        product_id: r.product_id as string,
        name: p?.spec ? `${p.name} ${p.spec}` : (p?.name ?? "(삭제된 품목)"),
        sku: p?.sku ?? null,
        return_date: String(r.return_date).slice(0, 10),
        qty: Number(r.qty) || 0,
        unit_amount: r.unit_amount == null ? null : Number(r.unit_amount),
        partner: (r.partner as string) ?? null,
        memo: (r.memo as string) ?? null,
      };
    });
    return NextResponse.json({ ok: true, rows, products });
  } catch (err) {
    console.error("[inventory/returns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "반품 내역 조회 실패") }, { status: 500 });
  }
}

// POST { product_id, qty, unit_amount?, return_date, partner?, memo? } — 반품 1건 기록.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as {
      product_id?: string; qty?: number | string; unit_amount?: number | string;
      return_date?: string; partner?: string; memo?: string;
    };
    const productId = String(b.product_id || "").trim();
    if (!productId) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    const qty = Math.round((Number(b.qty) || 0) * 100) / 100;
    if (!(qty > 0)) return NextResponse.json({ ok: false, error: "반품수량은 0보다 커야 합니다." }, { status: 400 });
    const date = String(b.return_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: "반품일이 올바르지 않습니다." }, { status: 400 });
    const unit = Math.round(Number(b.unit_amount) || 0);

    const { error } = await supabaseAdmin().from("purchase_returns").insert({
      product_id: productId, return_date: date, qty,
      unit_amount: unit > 0 ? unit : null,
      partner: String(b.partner || "").trim() || null,
      memo: String(b.memo || "").trim() || null,
      created_by: await actor(req),
    });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/returns POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "반품 기록 실패") }, { status: 500 });
  }
}
