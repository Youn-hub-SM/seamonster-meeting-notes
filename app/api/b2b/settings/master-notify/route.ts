import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv } from "@/app/lib/b2b-settings";
import {
  getMasterNotifyConfig, setMasterNotifyConfig, setMasterNotifyApiKey, sendMasterChat,
  MASTER_NOTIFY_EVENTS, type MasterNotifyConfig, type MasterNotifyEventKey,
} from "@/app/lib/master-notify";

export const dynamic = "force-dynamic";

// [업무도우미 변경알림] 설정 — 상품마스터 변경 시 Flow 채팅방 발송.
//  GET: 설정 조회(키 값은 비노출, 보유 여부만) / PUT: 저장(apiKey 는 입력 시에만 갱신) / POST: 테스트 발송.

export async function GET() {
  try {
    const cfg = await getMasterNotifyConfig();
    const [ownKey, vocKey] = await Promise.all([getKv("master_notify_api_key"), getKv("flow_api_key")]);
    return NextResponse.json({
      ok: true, config: cfg,
      hasApiKey: !!ownKey, fallbackKey: !ownKey && !!vocKey, // 전용 키 없으면 VOC Flow 키 폴백 사용 중
      events: MASTER_NOTIFY_EVENTS,
    });
  } catch (err) {
    console.error("[settings/master-notify GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<MasterNotifyConfig> & { apiKey?: string };
    const prev = await getMasterNotifyConfig();
    const roomId = String(b.roomId ?? prev.roomId).trim();
    if (roomId && !/^\d{1,15}$/.test(roomId)) {
      return NextResponse.json({ ok: false, error: "채팅방 ID 는 숫자(최대 15자)여야 합니다." }, { status: 400 });
    }
    const events = { ...prev.events };
    if (b.events) for (const e of MASTER_NOTIFY_EVENTS) if (typeof b.events[e.key] === "boolean") events[e.key as MasterNotifyEventKey] = b.events[e.key]!;
    const next: MasterNotifyConfig = {
      enabled: b.enabled === undefined ? prev.enabled : b.enabled === true,
      roomId,
      registerId: String(b.registerId ?? prev.registerId).trim() || prev.registerId,
      title: String(b.title ?? prev.title).trim() || prev.title,
      events,
    };
    await setMasterNotifyConfig(next);
    if (typeof b.apiKey === "string" && b.apiKey.trim()) await setMasterNotifyApiKey(b.apiKey.trim()); // 빈값이면 기존 키 유지
    return NextResponse.json({ ok: true, config: next });
  } catch (err) {
    console.error("[settings/master-notify PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// 테스트 발송 — 현재 설정으로 채팅방에 메시지 1건.
export async function POST() {
  try {
    const cfg = await getMasterNotifyConfig();
    const r = await sendMasterChat(`${cfg.title}\n테스트 메시지입니다. 이 방으로 상품마스터 변경 알림이 발송됩니다.`);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || `발송 실패(HTTP ${r.status})` }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[settings/master-notify POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 실패") }, { status: 500 });
  }
}
