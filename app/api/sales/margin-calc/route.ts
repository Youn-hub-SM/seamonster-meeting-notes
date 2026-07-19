import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { analyzeMargin, loadMarginRef, type MarginTurn } from "@/app/lib/margin-calc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — 질문 만들기 도우미용: 채널 목록 + 전체 상품(검색용) + 최근 30일 잘 팔린 상품(추천 칩)
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [{ data: chans }, { data: prods }, topRes] = await Promise.all([
      sb.from("sales_channel_config").select("channel").order("channel"),
      sb.from("products").select("name, spec, sku").eq("active", true).order("name"),
      // 판매량 상위 — run_report(068) 미적용이면 빈 목록 폴백. retail_price>0 로 부자재(드라이아이스 등) 제외.
      sb.rpc("run_report", { q: "select p.name from sales_orders o join products p on p.sku = o.sku_code and p.retail_price > 0 where o.order_date >= current_date - 30 group by 1 order by sum(o.quantity) desc limit 10" }),
    ]);
    const topProducts = Array.isArray(topRes.data) ? (topRes.data as { name: string }[]).map((r) => String(r.name)).filter(Boolean) : [];
    return NextResponse.json({
      ok: true,
      channels: (chans ?? []).map((c) => String(c.channel)).filter(Boolean),
      products: (prods ?? []).map((p) => ({ name: p.name as string, spec: (p.spec as string) || null, sku: (p.sku as string) || null })),
      topProducts,
    });
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

    const ref = await loadMarginRef();
    const hist = Array.isArray(history) ? history.filter((t) => t && typeof t.q === "string" && t.result) : [];
    const result = await analyzeMargin(q, ref, hist);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    // opus 응답 JSON 파싱 실패 등
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "분석 실패 — 질문을 조금 더 구체적으로 적어보세요.") }, { status: 500 });
  }
}
