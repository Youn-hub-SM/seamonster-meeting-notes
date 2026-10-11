import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { toInvChannelParam } from "@/app/lib/inventory";
import { kstTodayIso } from "@/app/lib/production-schedule";
import { countChecks, countDateError } from "../count-check";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/inventory/adjust/precheck?channel=&date= — 실사 전 점검(D4a·S8).
//  B2B 선점은 빠졌는데 안 나간 발주 · 대기 행 · 실사일 당일/이후 입출고를 칸 전체로 돌려준다.
//  실사 화면이 숫자를 세기 전에 보여 주고, 단건 조정 창도 같은 응답을 쓸 수 있다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const chan = toInvChannelParam(sp.get("channel"));
    if (!chan) return NextResponse.json({ ok: false, error: "실사할 칸을 고르세요." }, { status: 400 });
    const today = kstTodayIso();
    const date = sp.get("date") || today;
    const bad = countDateError(date, today);
    if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });
    const checks = await countChecks(supabaseAdmin(), { chan, date, today });
    return NextResponse.json({ ok: true, channel: chan, checks });
  } catch (err) {
    console.error("[inventory/adjust/precheck]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "실사 전 점검 실패") }, { status: 500 });
  }
}
