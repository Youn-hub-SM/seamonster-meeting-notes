import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { analyzeMargin, type MarginProduct, type MarginChannel } from "@/app/lib/margin-calc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { question } — 자연어 시나리오 → 원가표·채널정책 자동 제공 → opus 이익률 분석.
export async function POST(req: NextRequest) {
  try {
    const { question } = (await req.json()) as { question?: string };
    const q = (question || "").trim();
    if (!q) return NextResponse.json({ ok: false, error: "질문을 입력하세요." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY 가 설정되어 있지 않습니다." }, { status: 503 });

    const sb = supabaseAdmin();
    const [{ data: prods, error: pErr }, { data: chans }] = await Promise.all([
      sb.from("products").select("name, spec, sku, cost_price, retail_price, sale_price, volume_kg, tax_type").eq("active", true).order("name"),
      sb.from("sales_channel_config").select("channel, fee_rate, ship_mode, ship_fee, ship_free_over").order("channel"),
    ]);
    if (pErr) return NextResponse.json({ ok: false, error: `상품 조회 오류: ${pErr.message}` }, { status: 500 });

    const products: MarginProduct[] = (prods ?? []).map((p) => ({
      name: p.name, spec: p.spec, sku: p.sku,
      cost: Number(p.cost_price) || 0, retail: Number(p.retail_price) || 0, wholesale: Number(p.sale_price) || 0,
      volumeKg: p.volume_kg == null ? null : Number(p.volume_kg),
      tax: p.tax_type === "exempt" ? "exempt" : "taxable",
    }));
    const channels: MarginChannel[] = (chans ?? []).map((c) => ({
      channel: c.channel, feeRatePct: Math.round((Number(c.fee_rate) || 0) * 1000) / 10, // 0.108 → 10.8
      shipMode: c.ship_mode, shipFee: Number(c.ship_fee) || 0, shipFreeOver: Number(c.ship_free_over) || 0,
    }));

    const month = new Date(Date.now() + 9 * 3600e3).getUTCMonth() + 1; // KST 월
    const result = await analyzeMargin(q, { products, channels, month });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    // opus 응답 JSON 파싱 실패 등
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "분석 실패 — 질문을 조금 더 구체적으로 적어보세요.") }, { status: 500 });
  }
}
