import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const dynamic = "force-dynamic";

// 주간 생산 요청서 AI 초안의 'AI 검토 포인트'(Claude 호출) 켜기/끄기 — b2b_settings 'production_draft_ai_note' = "off" 면 끔.
//  수량은 수식이라 꺼도 초안은 그대로 만들어진다(메모의 검토 포인트만 빠진다). 반복 AI 호출 비용 제어(대표 규칙).
const KEY = "production_draft_ai_note";

export async function GET() {
  try {
    const v = (await getKv(KEY)).toLowerCase();
    return NextResponse.json({ ok: true, enabled: v !== "off" });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { enabled } = (await req.json()) as { enabled?: boolean };
    await setKv(KEY, enabled === false ? "off" : "on");
    return NextResponse.json({ ok: true, enabled: enabled !== false });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
