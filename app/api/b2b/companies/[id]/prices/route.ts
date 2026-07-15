import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

type PriceRow = {
  product_id: string;
  unit_price: number;
  memo: string | null;
  products?: { name?: string; sku?: string | null; spec?: string | null; sale_price?: number } | { name?: string; sku?: string | null; spec?: string | null; sale_price?: number }[] | null;
};

// GET — 이 거래처의 상품별 단가 목록(+상품명·SKU·규격·기본판매가 참고)
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("company_product_prices")
      .select("product_id, unit_price, memo, products(name, sku, spec, sale_price)")
      .eq("company_id", id);
    if (error) {
      // 070 미적용 등 → 빈 목록으로 그레이스풀(발주 화면이 기본판매가로 폴백)
      return NextResponse.json({ ok: true, prices: [] });
    }
    const prices = ((data ?? []) as PriceRow[]).map((r) => {
      const p = Array.isArray(r.products) ? r.products[0] : r.products;
      return {
        product_id: r.product_id,
        unit_price: Number(r.unit_price) || 0,
        memo: r.memo ?? null,
        name: p?.name ?? "(삭제된 품목)",
        sku: p?.sku ?? null,
        spec: p?.spec ?? null,
        default_price: Number(p?.sale_price) || 0,
      };
    });
    prices.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return NextResponse.json({ ok: true, prices });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "단가 조회 실패") }, { status: 500 });
  }
}

// POST { product_id, unit_price, memo? } — 거래처×상품 단가 추가/수정(upsert)
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const b = (await req.json()) as { product_id?: string; unit_price?: unknown; memo?: string };
    const product_id = String(b.product_id || "");
    if (!product_id) return NextResponse.json({ ok: false, error: "상품을 선택하세요." }, { status: 400 });
    const unit_price = Math.max(0, Math.round(Number(b.unit_price) || 0));
    const sb = supabaseAdmin();
    const { error } = await sb.from("company_product_prices").upsert(
      { company_id: id, product_id, unit_price, memo: String(b.memo || "").trim() || null, updated_at: new Date().toISOString() },
      { onConflict: "company_id,product_id" },
    );
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "단가 저장 실패") }, { status: 500 });
  }
}

// DELETE ?product_id= — 이 거래처의 해당 상품 단가 삭제(기본판매가로 복귀)
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const product_id = req.nextUrl.searchParams.get("product_id");
    if (!product_id) return NextResponse.json({ ok: false, error: "product_id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("company_product_prices").delete().eq("company_id", id).eq("product_id", product_id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "단가 삭제 실패") }, { status: 500 });
  }
}
