import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeRates, DEFAULT_RATES } from "@/app/lib/fulfill-rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "fulfill_rates";

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    if (error) return NextResponse.json({ ok: true, rates: DEFAULT_RATES }); // 미설정/조회실패 → 기본값
    return NextResponse.json({ ok: true, rates: normalizeRates(data?.value ?? {}) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const rates = normalizeRates(await req.json());
    const { error } = await supabaseAdmin().from("b2b_settings").upsert({ key: KEY, value: rates, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, rates });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}
