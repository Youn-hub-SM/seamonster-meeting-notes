import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getProductionAliases, setProductionAlias } from "@/app/lib/production-items";

export const dynamic = "force-dynamic";

// GET /api/production/item-alias
//  생산에서 묶이는 SKU 목록 + B2B 품목명들 + 현재 생산 표시명(별칭).
//  품목명이 2개 이상으로 갈리는 SKU(=B2B에서 업체별로 다르게 부르는 제품) 또는 별칭 설정된 SKU만 노출.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [{ data: products, error }, aliases] = await Promise.all([
      sb.from("products").select("sku, name").not("sku", "is", null),
      getProductionAliases(),
    ]);
    if (error) throw error;

    const m = new Map<string, string[]>();
    for (const p of products ?? []) {
      const k = String(p.sku).toUpperCase();
      const a = m.get(k) || [];
      a.push(p.name);
      m.set(k, a);
    }
    const items = [...m.entries()]
      .map(([sku, names]) => {
        const distinct = [...new Set(names)];
        const canonical = distinct.slice().sort((a, b) => a.length - b.length)[0];
        return { sku, names: distinct, canonical, alias: aliases[sku] || "", display: aliases[sku] || canonical };
      })
      .filter((it) => it.names.length > 1 || it.alias)
      .sort((a, b) => b.names.length - a.names.length || a.sku.localeCompare(b.sku));

    return NextResponse.json({ ok: true, items });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { sku, name } — 생산 표시명 저장(빈 값이면 기본 대표명으로 복귀)
export async function PUT(req: NextRequest) {
  try {
    const { sku, name } = (await req.json()) as { sku?: string; name?: string };
    if (!sku) return NextResponse.json({ ok: false, error: "sku 가 필요합니다." }, { status: 400 });
    const aliases = await setProductionAlias(sku, name || "");
    return NextResponse.json({ ok: true, aliases });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
