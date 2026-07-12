import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { buildB2BDigest, getDigestConfig, getDigestLastSent, setDigestLastSent, kstHour, kstDateStr } from "@/app/lib/b2b-digest";
import { sendFlowText } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const COOKIE = "b2b_auth";
async function userOf(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

// GET — 매시간 크론(Vercel: Authorization: Bearer CRON_SECRET)이 호출.
//  설정된 시각(hour)·활성(enabled)일 때만 실제 발송(하루 1회 dedup). 관리자 수동은 미리보기/?send=1.
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const secret = process.env.CRON_SECRET || "";
  const authz = req.headers.get("authorization") || "";
  const isCron = !!secret && (authz === `Bearer ${secret}` || sp.get("key") === secret);
  const name = await userOf(req);
  const isAdmin = name === "관리자" || name === "현석";
  if (!isCron && !isAdmin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

  const cfg = await getDigestConfig();

  // 크론: 설정 시각·활성·중복 검사 후 발송
  if (isCron && sp.get("send") !== "1") {
    if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: "disabled" });
    if (kstHour() !== cfg.hour) return NextResponse.json({ ok: true, skipped: `hour ${kstHour()}!=${cfg.hour}` });
    const today = kstDateStr();
    if ((await getDigestLastSent()) === today) return NextResponse.json({ ok: true, skipped: "already-sent" });
    const digest = await buildB2BDigest(cfg);
    const r = await sendFlowText(digest.text);
    if (r.ok) await setDigestLastSent(today);
    return NextResponse.json({ ok: r.ok, sent: r.ok, error: r.error, counts: digest.counts });
  }

  // 관리자 수동(또는 강제 send)
  const digest = await buildB2BDigest(cfg);
  if (sp.get("send") === "1") {
    const r = await sendFlowText(digest.text);
    return NextResponse.json({ ok: r.ok, sent: r.ok, error: r.error, counts: digest.counts });
  }
  return NextResponse.json({ ok: true, preview: digest.text, counts: digest.counts });
}
