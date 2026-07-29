import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getFlowBotId, setFlowBotId,
  getFlowBotApiKey, setFlowBotApiKey,
  getFlowReceiversRaw, setFlowReceiversRaw, getFlowReceivers,
  getFlowAlertTitle, setFlowAlertTitle,
  getAppBaseUrl, setAppBaseUrl,
  isFlowBotConfigured,
  getFlowBot2Id, setFlowBot2Id,
  getFlowBot2ApiKey, setFlowBot2ApiKey,
  getFlowBot2ReceiversRaw, setFlowBot2ReceiversRaw, getFlowBot2Receivers,
  getFlowBot2Title, setFlowBot2Title,
  isFlowBot2Configured, getFlowBot2Config,
} from "@/app/lib/b2b-settings";
import { sendFlowBotNotify } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 현재 Flow 봇 설정. API 키는 값 대신 유무(hasApiKey)만 반환(브라우저에 노출 안 함).
export async function GET() {
  try {
    const [botId, apiKey, receivers, title, appBaseUrl, active, bot2Id, bot2ApiKey, bot2Receivers, bot2Title, bot2Active] = await Promise.all([
      getFlowBotId(), getFlowBotApiKey(), getFlowReceiversRaw(), getFlowAlertTitle(), getAppBaseUrl(), isFlowBotConfigured(),
      getFlowBot2Id(), getFlowBot2ApiKey(), getFlowBot2ReceiversRaw(), getFlowBot2Title(), isFlowBot2Configured(),
    ]);
    return NextResponse.json({
      ok: true,
      botId,
      receivers,           // 원문(줄바꿈 포함) 그대로 — 편집용
      title,
      appBaseUrl,
      hasApiKey: !!apiKey,
      active,              // 봇 ID·키·수신자 모두 있으면 true → Zapier 대신 Flow 발송
      zapierEnv: !!process.env.ZAPIER_WEBHOOK_URL,
      // '업무도우미 변경알림' 봇(봇2) — 생산·재고 알림 전용
      bot2Id, bot2Receivers, bot2Title, bot2HasApiKey: !!bot2ApiKey, bot2Active,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { botId, apiKey?, receivers, title, appBaseUrl } — 저장.
//  apiKey 는 비어있지 않을 때만 갱신(빈값이면 기존 키 유지 → UI에서 매번 재입력 불필요).
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as {
      botId?: string; apiKey?: string; receivers?: string; title?: string; appBaseUrl?: string;
      bot2Id?: string; bot2ApiKey?: string; bot2Receivers?: string; bot2Title?: string;
    };
    if (b.botId !== undefined) await setFlowBotId(String(b.botId || ""));
    if (b.receivers !== undefined) await setFlowReceiversRaw(String(b.receivers || ""));
    if (b.title !== undefined) await setFlowAlertTitle(String(b.title || ""));
    if (b.appBaseUrl !== undefined) await setAppBaseUrl(String(b.appBaseUrl || ""));
    if (b.apiKey !== undefined && String(b.apiKey).trim()) await setFlowBotApiKey(String(b.apiKey));
    if (b.bot2Id !== undefined) await setFlowBot2Id(String(b.bot2Id || ""));
    if (b.bot2Receivers !== undefined) await setFlowBot2ReceiversRaw(String(b.bot2Receivers || ""));
    if (b.bot2Title !== undefined) await setFlowBot2Title(String(b.bot2Title || ""));
    if (b.bot2ApiKey !== undefined && String(b.bot2ApiKey).trim()) await setFlowBot2ApiKey(String(b.bot2ApiKey));
    return NextResponse.json({ ok: true, active: await isFlowBotConfigured(), bot2Active: await isFlowBot2Configured() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST { testReceiver? } — 테스트 발송(저장된 봇 설정 사용).
//  testReceiver 지정 시 그 1명에게만(동료 스팸 방지), 없으면 저장된 수신자 전체.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { testReceiver?: string; bot?: string };
    const helper = body.bot === "helper"; // '업무도우미 변경알림' 봇(봇2) 테스트
    if (!(helper ? await isFlowBot2Configured() : await isFlowBotConfigured())) {
      return NextResponse.json({ ok: false, error: "봇 ID·API 키·수신자를 먼저 저장하세요." }, { status: 400 });
    }
    const receivers = body.testReceiver && body.testReceiver.trim()
      ? [body.testReceiver.trim()]
      : helper ? await getFlowBot2Receivers() : await getFlowReceivers();

    const r = await sendFlowBotNotify(
      {
        event_type: "test",
        summary: helper
          ? "[테스트] 씨몬스터 업무 도우미 · 업무도우미 변경알림 봇 연결 확인"
          : "[테스트] 씨몬스터 업무 도우미 · B2B 알림 연결 확인",
        order_id: null,
        order_no: null,
      },
      "테스트",
      helper ? { receivers, config: await getFlowBot2Config() } : { receivers },
    );
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || `Flow 응답 ${r.status}` }, { status: 502 });
    return NextResponse.json({ ok: true, status: r.status, sentTo: receivers.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 실패") }, { status: 500 });
  }
}
