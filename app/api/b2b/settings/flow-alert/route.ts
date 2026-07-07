import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getFlowWebhookUrl, setFlowWebhookUrl, setAppBaseUrl, getAppBaseUrl } from "@/app/lib/b2b-settings";
import { sendFlowWebhook } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 현재 Flow 웹훅/앱주소 설정
export async function GET() {
  try {
    const [webhookUrl, appBaseUrl] = await Promise.all([getFlowWebhookUrl(), getAppBaseUrl()]);
    return NextResponse.json({
      ok: true,
      webhookUrl,
      appBaseUrl,
      zapierEnv: !!process.env.ZAPIER_WEBHOOK_URL,   // 폴백용 Zapier 환경변수 유무
      active: !!webhookUrl,                          // Flow 웹훅 설정되면 Zapier 대신 Flow 사용
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { webhookUrl, appBaseUrl } — 저장
export async function PUT(req: NextRequest) {
  try {
    const { webhookUrl, appBaseUrl } = (await req.json()) as { webhookUrl?: string; appBaseUrl?: string };
    if (webhookUrl !== undefined) await setFlowWebhookUrl(String(webhookUrl || ""));
    if (appBaseUrl !== undefined) await setAppBaseUrl(String(appBaseUrl || ""));
    return NextResponse.json({ ok: true, active: !!(await getFlowWebhookUrl()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST — 테스트 발송(저장된 웹훅, 또는 body.webhookUrl 로 미리보기 발송)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { webhookUrl?: string };
    const url = (body.webhookUrl || (await getFlowWebhookUrl())).trim();
    if (!url) return NextResponse.json({ ok: false, error: "Flow 웹훅 URL 을 먼저 입력하세요." }, { status: 400 });

    const r = await sendFlowWebhook(url, {
      event_type: "test",
      summary: "🔔 [테스트] 씨몬스터 업무 도우미 · B2B 알림 연결 확인",
      order_id: null,
      order_no: null,
    }, "테스트");
    if (!r.ok) return NextResponse.json({ ok: false, error: `Flow 응답 ${r.status || "연결 실패"} — URL·형식을 확인하세요.` }, { status: 502 });
    return NextResponse.json({ ok: true, status: r.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 실패") }, { status: 500 });
  }
}
