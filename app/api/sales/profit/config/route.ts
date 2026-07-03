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
      .select("channel,fee_rate,ship_mode,ship_fee,ship_free_over,ship_free_over_sub,revenue_adjust").order("channel");
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (046 적용 여부 확인)` }, { status: 500 });
    return NextResponse.json({ ok: true, rows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// POST { rows: ChannelConfig[], deleted?: string[], replace?: boolean } — 설정 저장.
//  · 같은 채널명이 여러 번 오면 마지막 값으로 dedup(upsert 중복키 충돌 방지).
//  · replace!==false(기본)면 제출 목록에 없는 기존 채널 설정은 정리 → 이름변경/삭제로 생긴 고아 제거.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: ChannelConfig[]; deleted?: string[]; replace?: boolean };
    const rows = (body.rows || []).filter((r) => r.channel && r.channel.trim());
    const sb = supabaseAdmin();
    const now = new Date().toISOString();

    // 채널명 기준 dedup(마지막 값 우선)
    const byCh = new Map<string, ChannelConfig>();
    for (const r of rows) byCh.set(r.channel.trim(), r);
    const clean = [...byCh.values()].map((r) => ({
      channel: r.channel.trim(),
      fee_rate: Math.min(1, Math.max(0, Number(r.fee_rate) || 0)),   // 0~100%로 클램프(오타로 500% 등 방지)
      ship_mode: ["actual", "flat", "free_over", "none"].includes(r.ship_mode) ? r.ship_mode : "actual",
      ship_fee: Math.max(0, Math.round(Number(r.ship_fee) || 0)),
      ship_free_over: Math.max(0, Math.round(Number(r.ship_free_over) || 0)),
      ship_free_over_sub: Math.max(0, Math.round(Number(r.ship_free_over_sub) || 0)),
      revenue_adjust: Math.min(0.9, Math.max(0, Number(r.revenue_adjust) || 0)),
      updated_at: now,
    }));

    // 명시적 삭제 목록(하위호환)
    if (body.deleted?.length) {
      const del = body.deleted.map((c) => (c || "").trim()).filter(Boolean);
      if (del.length) await sb.from("sales_channel_config").delete().in("channel", del);
    }

    if (clean.length) {
      const { error } = await sb.from("sales_channel_config").upsert(clean, { onConflict: "channel" });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

      // 전체 재조정: 제출 목록에 없는 채널은 제거(이름변경 시 옛 이름 고아 방지)
      if (body.replace !== false) {
        const keep = new Set(clean.map((c) => c.channel));
        const { data: existing } = await sb.from("sales_channel_config").select("channel");
        const orphans = (existing ?? []).map((e) => e.channel as string).filter((ch) => !keep.has(ch));
        if (orphans.length) await sb.from("sales_channel_config").delete().in("channel", orphans);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
