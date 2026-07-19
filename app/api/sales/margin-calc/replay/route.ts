import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { loadMarginRef, computeSpecItem, type MarginSpec, type MarginResult, type MarginResultItem } from "@/app/lib/margin-calc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { specs, name? } — 저장된 계산 스펙(레시피)을 AI 없이 '현재' 원가·수수료·계절 기준으로 즉시 계산.
//  리포트의 '저장 SQL 재실행'에 해당. 개별 스펙 실패(상품 삭제 등)는 assumptions 로 알린다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { specs?: MarginSpec[]; name?: string };
    const specs = Array.isArray(b.specs) ? b.specs.filter((s) => s && s.productName && s.channel) : [];
    if (!specs.length) return NextResponse.json({ ok: false, error: "계산 스펙이 없습니다." }, { status: 400 });

    const ref = await loadMarginRef();
    const results: MarginResultItem[] = [];
    const assumptions: string[] = [];
    for (const spec of specs) {
      try { results.push(computeSpecItem(spec, ref)); }
      catch (e) { assumptions.push(e instanceof Error ? e.message : "계산 실패"); }
    }
    if (!results.length) {
      return NextResponse.json({ ok: false, error: `재계산 실패 — ${assumptions.join(" · ") || "스펙을 계산할 수 없습니다"}` }, { status: 400 });
    }
    for (const r of results) if ((ref.products.find((p) => p.name === r.spec?.productName)?.volumeKg ?? null) == null) {
      assumptions.push(`'${r.spec?.productName}' 부피 미입력 — 2kg 로 가정해 배송원가를 계산했습니다`);
    }
    const result: MarginResult = {
      scenario: `${b.name ? `${b.name} — ` : ""}현재 원가·수수료·계절 기준 재계산`,
      product: specs[0].productName,
      results,
      assumptions: [...new Set(assumptions)],
    };
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "재계산 실패") }, { status: 500 });
  }
}
