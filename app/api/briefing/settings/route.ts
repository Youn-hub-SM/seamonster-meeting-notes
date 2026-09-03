import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return isAdminName(name || "");
}

// GET — 브리핑 설정(자동 생성 여부, 팀즈 웹훅 URL). 관리자 전용.
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 설정입니다." }, { status: 403 });
    const [auto, webhook] = await Promise.all([getKv("briefing_auto"), getKv("briefing_webhook")]);
    return NextResponse.json({ ok: true, auto: auto !== "off", webhook });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 조회 실패") }, { status: 500 });
  }
}

// PUT { auto?, webhook? }
export async function PUT(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 설정입니다." }, { status: 403 });
    const b = (await req.json()) as { auto?: boolean; webhook?: string };
    if (b.auto !== undefined) await setKv("briefing_auto", b.auto ? "on" : "off");
    if (b.webhook !== undefined) {
      const url = String(b.webhook).trim();
      if (url && !/^https:\/\//.test(url)) return NextResponse.json({ ok: false, error: "웹훅 URL은 https:// 로 시작해야 합니다." }, { status: 400 });
      await setKv("briefing_webhook", url);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
