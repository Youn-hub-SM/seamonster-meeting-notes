import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// 공용 상품 마스터(읽기 전용) — 생산·발주·VOC 등 모든 도구가 끌어다 쓰는 단일 소스.
// 편집은 /b2b/products(상품 마스터)에서. products 테이블이 단일 원본.
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("products")
      .select("id, sku, name, spec, unit")
      .eq("active", true)
      .order("name", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, products: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "상품 조회 실패") }, { status: 500 });
  }
}
