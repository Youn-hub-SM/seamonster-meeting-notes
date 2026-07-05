import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/inventory/reconcile?from=&to=&channel=
//  재고 정합성 대사 — 실제 판매(sales_orders)를 '실제 출고'로 보고 재고 원장과 대조.
//  기간 미지정 시 매출 최신일 기준 최근 30일.
export async function GET(req: NextRequest) {
  try {
    const p = new URL(req.url).searchParams;
    let from = (p.get("from") || "").trim();
    let to = (p.get("to") || "").trim();
    const channel = (p.get("channel") || "").trim(); // "" | "도매" | "소매"

    const sb = supabaseAdmin();
    if (!from || !to) {
      const { data: b } = await sb.rpc("sales_date_bounds");
      const max = Array.isArray(b) && b[0]?.max_date ? String(b[0].max_date) : null;
      if (!max) return NextResponse.json({ ok: false, error: "매출 데이터가 없습니다." }, { status: 400 });
      to = to || max;
      if (!from) {
        const d = new Date(`${to}T00:00:00`);
        d.setDate(d.getDate() - 30);
        from = d.toISOString().slice(0, 10);
      }
    }

    const { data, error } = await sb.rpc("inventory_reconcile", {
      p_from: from, p_to: to, p_channel: channel || null,
    });
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (051 적용 여부 확인)` }, { status: 500 });

    return NextResponse.json({ ok: true, from, to, channel: channel || "전체", rows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "대사 조회 실패") }, { status: 500 });
  }
}
