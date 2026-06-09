import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeProduct, ProductInput } from "@/app/lib/b2b-types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("products")
      .select("*")
      .order("active", { ascending: false })
      .order("name", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, products: data ?? [] });
  } catch (err) {
    console.error("[b2b/products GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ProductInput;
    if (!body.name?.trim()) {
      return NextResponse.json({ ok: false, error: "품목명은 필수입니다." }, { status: 400 });
    }
    const clean = normalizeProduct(body);
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("products")
      .insert({
        sku: clean.sku,
        name: clean.name,
        spec: clean.spec,
        unit: clean.unit,
        cost_price: clean.cost_price,
        sale_price: clean.sale_price,
        tax_type: clean.tax_type,
        active: clean.active,
        notes: clean.notes,
        cost_material: clean.cost_material,
        pkg_inner: clean.pkg_inner,
        pkg_label: clean.pkg_label,
        pkg_outer: clean.pkg_outer,
        volume_kg: clean.volume_kg,
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { ok: false, error: "이미 같은 SKU 가 등록되어 있습니다." },
          { status: 409 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true, product: data });
  } catch (err) {
    console.error("[b2b/products POST]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "등록 실패") },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as ProductInput;
    if (!body.id) {
      return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });
    }
    if (!body.name?.trim()) {
      return NextResponse.json({ ok: false, error: "품목명은 필수입니다." }, { status: 400 });
    }
    const clean = normalizeProduct(body);
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("products")
      .update({
        sku: clean.sku,
        name: clean.name,
        spec: clean.spec,
        unit: clean.unit,
        cost_price: clean.cost_price,
        sale_price: clean.sale_price,
        tax_type: clean.tax_type,
        active: clean.active,
        notes: clean.notes,
        cost_material: clean.cost_material,
        pkg_inner: clean.pkg_inner,
        pkg_label: clean.pkg_label,
        pkg_outer: clean.pkg_outer,
        volume_kg: clean.volume_kg,
      })
      .eq("id", body.id)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { ok: false, error: "이미 같은 SKU 가 등록되어 있습니다." },
          { status: 409 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true, product: data });
  } catch (err) {
    console.error("[b2b/products PUT]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "수정 실패") },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { error } = await sb.from("products").delete().eq("id", id);
    if (error) {
      if (error.code === "23503") {
        return NextResponse.json(
          { ok: false, error: "이 제품이 들어있는 발주가 있어 삭제할 수 없습니다. 대신 '미사용' 처리하세요." },
          { status: 409 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/products DELETE]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "삭제 실패") },
      { status: 500 }
    );
  }
}
