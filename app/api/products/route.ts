import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getAllBundles } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";

// 공용 상품 마스터(읽기 전용) — 생산·발주·VOC 등 모든 도구가 끌어다 쓰는 단일 소스.
// 편집은 /b2b/products(상품 마스터)에서. products 테이블이 단일 원본.
//
// 묶음(세트) 상품은 자기 cost_price·volume_kg 가 보통 0/미입력이라, 구성품 합으로 '치환'해서 내려줌
// (매출이익 RPC 와 동일 규칙: 구성품 중 부피 결측이 있으면 부피=null). 이래야 VOC 손해금액 자동계산 등이
// 묶음 상품에서도 실제 원가를 잡음. raw 값이 필요하면 /b2b/products(상품 마스터)를 사용.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [{ data, error }, bundles] = await Promise.all([
      sb.from("products").select("id, sku, name, spec, unit, sale_price, cost_price, volume_kg, active").order("name", { ascending: true }),
      getAllBundles(sb), // parent_id → 구성품[] (037 미적용이면 빈 맵 → 치환 없음)
    ]);
    if (error) throw error;
    const all = data ?? [];

    // 구성품 원가/부피 조회용 전체 맵(비활성 포함 — 구성품이 비활성일 수 있음)
    const byId = new Map<string, { cost: number; vol: number | null }>();
    for (const p of all) byId.set(p.id, { cost: Number(p.cost_price) || 0, vol: p.volume_kg == null ? null : Number(p.volume_kg) });

    // 묶음 부모 → 구성품 합(1레벨). 구성품 부피가 하나라도 결측이면 부피=null.
    const resolve = (id: string): { cost: number; vol: number | null } | null => {
      const comps = bundles.get(id);
      if (!comps) return null;
      let cost = 0, vol: number | null = 0, volMissing = false;
      for (const c of comps) {
        const co = byId.get(c.component_id);
        if (!co) { volMissing = true; continue; }
        cost += co.cost * c.qty;
        if (co.vol == null) volMissing = true;
        else if (vol != null) vol += co.vol * c.qty;
      }
      return { cost, vol: volMissing ? null : vol };
    };

    const products = all
      .filter((p) => p.active)
      .map((p) => {
        const r = resolve(p.id);
        return r ? { ...p, cost_price: r.cost, volume_kg: r.vol, is_bundle: true } : p;
      });
    return NextResponse.json({ ok: true, products });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "상품 조회 실패") }, { status: 500 });
  }
}
