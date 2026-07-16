import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getDigestConfig, saveDigestConfig, getDigestLastSent, type DigestConfig } from "@/app/lib/b2b-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "b2b_auth";
async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get(COOKIE)?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return name === "관리자" || name === "현석";
}

export async function GET() {
  // 자동 발송 진단 정보 포함 — lastSent(마지막 자동 발송일, 크론 성공 시에만 기록)와
  //  cronSecretSet(Vercel CRON_SECRET 환경변수 유무 — 없으면 크론이 매일 401 로 조용히 실패).
  const [config, lastSent] = await Promise.all([getDigestConfig(), getDigestLastSent()]);
  return NextResponse.json({ ok: true, config, lastSent: lastSent || null, cronSecretSet: !!process.env.CRON_SECRET });
}

export async function PUT(req: NextRequest) {
  if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "관리자만 변경할 수 있습니다." }, { status: 403 });
  const b = (await req.json()) as Partial<DigestConfig>;
  return NextResponse.json({ ok: true, config: await saveDigestConfig(b) });
}
