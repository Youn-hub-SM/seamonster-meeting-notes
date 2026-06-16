import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getNotifyConfig, setNotifyConfig, NOTIFY_EVENTS, NotifyConfig } from "@/app/lib/b2b-settings";

export const dynamic = "force-dynamic";

// GET /api/b2b/settings/notify — 현재 알림 설정 + 이벤트 메타 + 웹훅 설정 여부
export async function GET() {
  try {
    const config = await getNotifyConfig();
    return NextResponse.json({
      ok: true,
      config,
      events: NOTIFY_EVENTS,
      webhookSet: !!process.env.ZAPIER_WEBHOOK_URL,
    });
  } catch (err) {
    console.error("[b2b/settings/notify GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/b2b/settings/notify — 알림 설정 저장
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { config?: NotifyConfig };
    if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
      return NextResponse.json({ ok: false, error: "설정 형식이 올바르지 않습니다." }, { status: 400 });
    }
    await setNotifyConfig(body.config);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/settings/notify PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
