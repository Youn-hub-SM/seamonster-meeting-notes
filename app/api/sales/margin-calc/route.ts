import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { analyzeMargin, type MarginProduct, type MarginChannel, type MarginTurn } from "@/app/lib/margin-calc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — 질문 만들기 도우미용 채널 목록(수수료 설정된 실제 채널)
export async function GET() {
  try {
    const { data } = await supabaseAdmin().from("sales_channel_config").select("channel").order("channel");
    return NextResponse.json({ ok: true, channels: (data ?? []).map((c) => String(c.channel)).filter(Boolean) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "채널 조회 실패") }, { status: 500 });
  }
}

// POST { question, history? } — 자연어 시나리오 → 원가표·채널정책 자동 제공 → opus 이익률 분석.
//  history: [{ q, result }] — '이어서 질문'(이전 시나리오를 문맥으로 수정·비교).
export async function POST(req: NextRequest) {
  try {
    const { question, history } = (await req.json()) as { question?: string; history?: MarginTurn[] };
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
    const hist = Array.isArray(history) ? history.filter((t) => t && typeof t.q === "string" && t.result) : [];
    const result = await analyzeMargin(q, { products, channels, month }, hist);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    // opus 응답 JSON 파싱 실패 등
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "분석 실패 — 질문을 조금 더 구체적으로 적어보세요.") }, { status: 500 });
  }
}
