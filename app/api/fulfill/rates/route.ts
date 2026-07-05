import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeHistory, ratesFor } from "@/app/lib/fulfill-rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "fulfill_rates";
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// GET → { history: 적용일 오름차순 단가 이력, rates: 오늘 유효한 단가 }
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    const history = normalizeHistory(error ? {} : (data?.value ?? {})); // 미설정/조회실패 → 기본값 1벌
    return NextResponse.json({ ok: true, history, rates: ratesFor(history, kstToday()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// POST body: { versions: RateVersion[] } | RateVersion[] → 전체 이력 교체
export async function POST(req: NextRequest) {
  try {
    const history = normalizeHistory(await req.json());
    const { error } = await supabaseAdmin().from("b2b_settings").upsert({ key: KEY, value: { versions: history }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, history, rates: ratesFor(history, kstToday()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}
