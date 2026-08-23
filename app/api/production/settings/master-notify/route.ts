import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getMasterNotifyConfig, setMasterNotifyConfig,
  MASTER_NOTIFY_EVENTS, type MasterNotifyConfig, type MasterNotifyEventKey,
} from "@/app/lib/master-notify";
import { getB2BTeamsConfig, sendTeamsWebhook } from "@/app/lib/b2b-teams";

export const dynamic = "force-dynamic";

// [업무도우미 변경알림] 설정(생산관리) — 켜기 + 이벤트 체크리스트. 발송은 Teams 채널(2026-08-23 Flow 제거).
//  GET: 설정 조회 / PUT: 저장 / POST: 테스트 발송(Teams 변경알림 채널로).

export async function GET() {
  try {
    const cfg = await getMasterNotifyConfig();
    return NextResponse.json({ ok: true, config: cfg, events: MASTER_NOTIFY_EVENTS });
  } catch (err) {
    console.error("[production/settings/master-notify GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<MasterNotifyConfig>;
    const prev = await getMasterNotifyConfig();
    const events = { ...prev.events };
    if (b.events) for (const e of MASTER_NOTIFY_EVENTS) if (typeof b.events[e.key] === "boolean") events[e.key as MasterNotifyEventKey] = b.events[e.key]!;
    const next: MasterNotifyConfig = {
      ...prev, // botId·receivers·title 은 저장값 호환용으로 유지(미사용)
      enabled: b.enabled === undefined ? prev.enabled : b.enabled === true,
      events,
    };
    await setMasterNotifyConfig(next);
    return NextResponse.json({ ok: true, config: next });
  } catch (err) {
    console.error("[production/settings/master-notify PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// 테스트 발송 — Teams '업무도우미 변경알림' 채널(미설정 시 B2B 알림 채널)로 한 장.
export async function POST() {
  try {
    const t = await getB2BTeamsConfig();
    const target = t.helperUrl || t.url;
    if (!target) return NextResponse.json({ ok: false, error: "Teams 웹훅 URL이 없습니다 — 관리자 › 설정 › B2B 도매의 'Teams 알림'에서 등록하세요." }, { status: 400 });
    const r = await sendTeamsWebhook(target, "테스트 메시지입니다. 상품마스터 변경(등록·수정·삭제·묶음·엑셀)과 생산·재고 알림이 이 채널로 발송됩니다.", { title: "업무도우미 변경알림 — 테스트" });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || `발송 실패(HTTP ${r.status})` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[production/settings/master-notify POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 실패") }, { status: 500 });
  }
}
