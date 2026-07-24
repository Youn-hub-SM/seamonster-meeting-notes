import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeHistory, ratesFor, normalizeBoxCats, validateBoxCats } from "@/app/lib/fulfill-rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "fulfill_rates";
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// GET → { history: 적용일 오름차순 단가 이력, rates: 오늘 유효한 단가 }
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    const stored = error ? {} : (data?.value ?? {});
    const history = normalizeHistory(stored); // 미설정/조회실패 → 기본값 1벌
    const boxCats = normalizeBoxCats((stored as { boxCats?: unknown })?.boxCats);
    return NextResponse.json({ ok: true, history, rates: ratesFor(history, kstToday()), boxCats });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// POST body: { versions: RateVersion[], boxCats?: BoxCat[] } | RateVersion[] → 전체 이력 교체
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const history = normalizeHistory(body);
    const boxCats = normalizeBoxCats((body as { boxCats?: unknown })?.boxCats);
    // 박스 종류가 요율 구간을 걸치면 배송일지 직접수정 시 금액이 어긋난다 → 저장 거부.
    //  검증은 '가장 최근 단가'의 구간 기준(앞으로 쓰일 값).
    const errs = validateBoxCats(boxCats, history[history.length - 1].boxTiers);
    if (errs.length) return NextResponse.json({ ok: false, error: errs.join("\n") }, { status: 400 });
    const { error } = await supabaseAdmin().from("b2b_settings").upsert({ key: KEY, value: { versions: history, boxCats }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, history, rates: ratesFor(history, kstToday()), boxCats });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}
