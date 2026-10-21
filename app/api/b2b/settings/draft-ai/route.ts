import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/app/lib/admin-req";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import { getDraftSchedule, saveDraftSchedule, getDraftLastRun, type DraftSchedule } from "@/app/lib/production-draft-schedule";

export const dynamic = "force-dynamic";

// 주간 생산 요청서 AI 초안 설정 — 관리자 › 설정 › 생산·재고.
//  enabled = 'AI 검토 포인트'(Claude 호출) 켜기/끄기 — b2b_settings 'production_draft_ai_note' = "off" 면 끔.
//   수량은 수식이라 꺼도 초안은 그대로 만들어진다(메모의 검토 포인트만 빠진다). 반복 AI 호출 비용 제어(대표 규칙).
//  schedule = 자동 작성 켜기/끄기 · 작성 시각(수요일, production-draft-schedule.ts — 2026-10-21). lastRun = 마지막 자동 작성 결과.
const KEY = "production_draft_ai_note";

export async function GET() {
  try {
    const [v, schedule, lastRun] = await Promise.all([getKv(KEY), getDraftSchedule(), getDraftLastRun()]);
    return NextResponse.json({ ok: true, enabled: v.toLowerCase() !== "off", schedule, lastRun: lastRun || null, cronKeySet: !!process.env.DIGEST_CRON_KEY });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { enabled?: boolean, schedule?: { enabled?, time? } }
export async function PUT(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny; // 관리자만 저장(2026-10-21 설정 통합)
  try {
    const b = (await req.json()) as { enabled?: boolean; schedule?: Partial<DraftSchedule> };
    let schedule: DraftSchedule | undefined;
    if (b.schedule) {
      try { schedule = await saveDraftSchedule(b.schedule); }
      catch (e) { return NextResponse.json({ ok: false, error: extractErrorMsg(e, "작성 시각을 확인하세요") }, { status: 400 }); }
    }
    if (b.enabled !== undefined) await setKv(KEY, b.enabled === false ? "off" : "on");
    const v = await getKv(KEY);
    return NextResponse.json({ ok: true, enabled: v.toLowerCase() !== "off", schedule: schedule ?? (await getDraftSchedule()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
