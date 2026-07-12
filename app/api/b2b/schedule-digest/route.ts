import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { buildB2BDigest } from "@/app/lib/b2b-digest";
import { sendFlowText } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const COOKIE = "b2b_auth";
async function userOf(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

// GET — 매일 아침 크론(Vercel: Authorization: Bearer CRON_SECRET) 또는 관리자 수동.
//  크론이면 발송, 관리자면 기본 미리보기(?send=1 이면 발송).
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const secret = process.env.CRON_SECRET || "";
  const authz = req.headers.get("authorization") || "";
  const isCron = !!secret && (authz === `Bearer ${secret}` || sp.get("key") === secret);
  const name = await userOf(req);
  const isAdmin = name === "관리자" || name === "현석";
  if (!isCron && !isAdmin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

  const digest = await buildB2BDigest();
  const doSend = isCron || sp.get("send") === "1";
  if (!doSend) return NextResponse.json({ ok: true, preview: digest.text, counts: digest.counts });

  const r = await sendFlowText(digest.text);
  return NextResponse.json({ ok: r.ok, sent: r.ok, error: r.error, counts: digest.counts });
}
