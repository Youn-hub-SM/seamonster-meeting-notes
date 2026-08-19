import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getB2BTeamsConfig, setB2BTeamsConfig, sendTeamsWebhook } from "@/app/lib/b2b-teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Teams 알림(Workflows 웹훅) 설정 — B2B 설정 화면의 'Teams 알림' 카드가 쓴다.
//  URL 은 채널 게시 권한 그 자체이므로 브라우저에는 유무(hasUrl)와 마스킹된 꼬리만 돌려준다.

export async function GET() {
  try {
    const cfg = await getB2BTeamsConfig();
    return NextResponse.json({
      ok: true,
      enabled: cfg.enabled,
      hasUrl: !!cfg.url,
      urlTail: cfg.url ? `…${cfg.url.slice(-12)}` : "",
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { url?, enabled? } — 저장. url 은 비어있지 않을 때만 갱신(빈값이면 기존 URL 유지).
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { url?: string; enabled?: boolean };
    const cur = await getB2BTeamsConfig();
    const nextUrl = b.url !== undefined && String(b.url).trim() ? String(b.url).trim() : cur.url;
    if (nextUrl && !/^https:\/\//.test(nextUrl)) {
      return NextResponse.json({ ok: false, error: "https:// 로 시작하는 웹훅 URL을 넣으세요." }, { status: 400 });
    }
    const next = { url: nextUrl, enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled };
    await setB2BTeamsConfig(next);
    return NextResponse.json({ ok: true, enabled: next.enabled, hasUrl: !!next.url });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST — 테스트 발송. 저장된 URL 로 카드 한 장을 보낸다(enabled 여부와 무관 — 켜기 전 확인용).
export async function POST() {
  try {
    const cfg = await getB2BTeamsConfig();
    if (!cfg.url) return NextResponse.json({ ok: false, error: "웹훅 URL을 먼저 저장하세요." }, { status: 400 });
    const r = await sendTeamsWebhook(
      cfg.url,
      "업무도우미와 Teams 채널이 연결됐습니다.\n발주 알림과 아침 일정 브리핑이 이 채널로 들어옵니다.",
      { title: "씨몬스터 업무도우미 — 테스트 발송" }
    );
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || `발송 실패 (HTTP ${r.status})` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 발송 실패") }, { status: 500 });
  }
}
