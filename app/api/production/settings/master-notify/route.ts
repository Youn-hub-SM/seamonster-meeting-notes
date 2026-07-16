import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv } from "@/app/lib/b2b-settings";
import {
  getMasterNotifyConfig, setMasterNotifyConfig, setMasterNotifyApiKey, sendMasterBot,
  MASTER_NOTIFY_EVENTS, type MasterNotifyConfig, type MasterNotifyEventKey,
} from "@/app/lib/master-notify";

export const dynamic = "force-dynamic";

// [업무도우미 변경알림] 설정(생산관리) — 상품마스터 변경 시 Flow 알림봇으로 수신자들에게 발송.
//  GET: 설정 조회(키 값 비노출) / PUT: 저장(apiKey 는 입력 시에만 갱신) / POST: 테스트 발송.

export async function GET() {
  try {
    const cfg = await getMasterNotifyConfig();
    const [ownKey, botKey] = await Promise.all([getKv("master_notify_api_key"), getKv("flow_bot_api_key")]);
    return NextResponse.json({
      ok: true, config: cfg,
      hasApiKey: !!ownKey, fallbackKey: !ownKey && !!botKey, // 전용 키 없으면 B2B 알림봇 키 폴백 사용 중
      events: MASTER_NOTIFY_EVENTS,
    });
  } catch (err) {
    console.error("[production/settings/master-notify GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<MasterNotifyConfig> & { apiKey?: string };
    const prev = await getMasterNotifyConfig();
    const events = { ...prev.events };
    if (b.events) for (const e of MASTER_NOTIFY_EVENTS) if (typeof b.events[e.key] === "boolean") events[e.key as MasterNotifyEventKey] = b.events[e.key]!;
    const next: MasterNotifyConfig = {
      enabled: b.enabled === undefined ? prev.enabled : b.enabled === true,
      botId: String(b.botId ?? prev.botId).trim() || prev.botId,
      receivers: String(b.receivers ?? prev.receivers).trim(),
      title: String(b.title ?? prev.title).trim() || prev.title,
      events,
    };
    await setMasterNotifyConfig(next);
    if (typeof b.apiKey === "string" && b.apiKey.trim()) await setMasterNotifyApiKey(b.apiKey.trim()); // 빈값이면 기존 키 유지
    return NextResponse.json({ ok: true, config: next });
  } catch (err) {
    console.error("[production/settings/master-notify PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// 테스트 발송 — body.testReceiver 지정 시 그 사람에게만, 없으면 설정된 수신자 전체.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { testReceiver?: string };
    const r = await sendMasterBot(
      "테스트 메시지입니다. 상품마스터 변경(등록·수정·삭제·묶음·엑셀) 시 이 알림이 발송됩니다.",
      b.testReceiver?.trim() ? { receivers: [b.testReceiver.trim()] } : undefined
    );
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || `발송 실패(HTTP ${r.status})` }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[production/settings/master-notify POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 실패") }, { status: 500 });
  }
}
