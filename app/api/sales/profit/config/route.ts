import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import type { ChannelConfig } from "@/app/lib/sales-profit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 채널별 수수료·배송비 설정 목록.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("sales_channel_config")
      .select("channel,fee_rate,ship_mode,ship_fee,ship_free_over,ship_free_over_sub").order("channel");
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (046 적용 여부 확인)` }, { status: 500 });
    return NextResponse.json({ ok: true, rows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// POST { rows: ChannelConfig[], deleted?: string[] } — 설정 upsert + 삭제된 채널 제거.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: ChannelConfig[]; deleted?: string[] };
    const rows = (body.rows || []).filter((r) => r.channel && r.channel.trim());
    const sb = supabaseAdmin();
    const now = new Date().toISOString();
    if (body.deleted?.length) {
      await sb.from("sales_channel_config").delete().in("channel", body.deleted.filter(Boolean));
    }
    if (rows.length) {
      const clean = rows.map((r) => ({
        channel: r.channel.trim(),
        fee_rate: Math.max(0, Number(r.fee_rate) || 0),
        ship_mode: ["actual", "flat", "free_over", "none"].includes(r.ship_mode) ? r.ship_mode : "actual",
        ship_fee: Math.max(0, Math.round(Number(r.ship_fee) || 0)),
        ship_free_over: Math.max(0, Math.round(Number(r.ship_free_over) || 0)),
        ship_free_over_sub: Math.max(0, Math.round(Number(r.ship_free_over_sub) || 0)),
        updated_at: now,
      }));
      const { error } = await sb.from("sales_channel_config").upsert(clean, { onConflict: "channel" });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
