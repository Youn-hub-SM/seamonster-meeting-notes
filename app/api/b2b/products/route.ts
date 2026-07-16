import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeProduct, ProductInput } from "@/app/lib/b2b-types";
import { logProductChange } from "@/app/lib/b2b-activity";
import { notifyMasterChange } from "@/app/lib/master-notify";
import { getAllBundles } from "@/app/lib/product-bundles";
import { diffProduct } from "@/app/lib/product-diff";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [{ data, error }, bundles] = await Promise.all([
      sb.from("products").select("*").order("active", { ascending: false }).order("name", { ascending: true }),
      getAllBundles(sb), // 부모 product_id → 구성품[] (037 미적용이면 빈 맵 → is_bundle 전부 false)
    ]);
    if (error) throw error;
    const products = (data ?? []).map((p) => {
      const comps = bundles.get(p.id);
      return { ...p, is_bundle: !!comps, bundle_count: comps?.length ?? 0 };
    });
    return NextResponse.json({ ok: true, products });
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
        purchase_price: clean.purchase_price,
        retail_price: clean.retail_price,
        sale_price: clean.sale_price,
        tax_type: clean.tax_type,
        active: clean.active,
        origin: clean.origin,
        attrs: clean.attrs,
        notes: clean.notes,
        cost_material: clean.cost_material,
        pkg_inner: clean.pkg_inner,
        pkg_label: clean.pkg_label,
        pkg_outer: clean.pkg_outer,
        volume_kg: clean.volume_kg,
        courier_name: clean.courier_name,
        courier_weight: clean.courier_weight,
        scan_name: clean.scan_name,
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        // migration 073: upper(sku) 유니크 인덱스 — 대소문자만 달라도 같은 SKU 로 취급
        return NextResponse.json(
          { ok: false, error: `이미 같은 SKU(${clean.sku})가 등록되어 있습니다. 다른 SKU 를 입력하세요.` },
          { status: 409 }
        );
      }
      throw error;
    }
    await logProductChange("created", data.name, data.sku, { source: "수동등록", productId: data.id });
    await notifyMasterChange("created", [`상품 등록 — ${data.name}${data.sku ? ` (${data.sku})` : ""}`]);
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
    const { data: before } = await sb.from("products").select("*").eq("id", body.id).single(); // 변경 diff 용 이전값
    const { data, error } = await sb
      .from("products")
      .update({
        sku: clean.sku,
        name: clean.name,
        spec: clean.spec,
        unit: clean.unit,
        cost_price: clean.cost_price,
        purchase_price: clean.purchase_price,
        retail_price: clean.retail_price,
        sale_price: clean.sale_price,
        tax_type: clean.tax_type,
        active: clean.active,
        origin: clean.origin,
        attrs: clean.attrs,
        notes: clean.notes,
        cost_material: clean.cost_material,
        pkg_inner: clean.pkg_inner,
        pkg_label: clean.pkg_label,
        pkg_outer: clean.pkg_outer,
        volume_kg: clean.volume_kg,
        courier_name: clean.courier_name,
        courier_weight: clean.courier_weight,
        scan_name: clean.scan_name,
      })
      .eq("id", body.id)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { ok: false, error: `이미 같은 SKU(${clean.sku})가 등록된 다른 품목이 있습니다. 다른 SKU 를 입력하세요.` },
          { status: 409 }
        );
      }
      throw error;
    }
    const changes = diffProduct(before, data);
    if (changes.length) {
      await logProductChange("updated", data.name, data.sku, { source: "수동수정", changes, productId: data.id });
      await notifyMasterChange("updated", [
        `상품 수정 — ${data.name}${data.sku ? ` (${data.sku})` : ""}`,
        ...changes.map((c) => `- ${c.label}: ${c.from} → ${c.to}`),
      ]);
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
    const { data: snap } = await sb.from("products").select("name, sku").eq("id", id).single();
    // 재고 원장이 있으면 삭제 차단 — inventory_txns FK 는 on delete cascade(031)라
    //  그냥 지우면 입출고 이력 전체가 조용히 소멸해 현재고·대사 기준이 무너진다. (031 미적용 환경이면 count=null 로 통과)
    const { count: txnCount } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("product_id", id);
    if ((txnCount ?? 0) > 0) {
      return NextResponse.json(
        { ok: false, error: `이 품목은 재고 입출고 이력(${txnCount}건)이 있어 삭제할 수 없습니다. 삭제하면 재고 기록이 함께 사라집니다. 대신 '미사용' 처리하세요.` },
        { status: 409 }
      );
    }
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
    if (snap?.name) {
      await logProductChange("deleted", snap.name, snap.sku, { source: "수동삭제" });
      await notifyMasterChange("deleted", [`상품 삭제 — ${snap.name}${snap.sku ? ` (${snap.sku})` : ""}`]);
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
