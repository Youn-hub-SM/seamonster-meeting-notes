import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getDigestConfig, saveDigestConfig, type DigestConfig } from "@/app/lib/b2b-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "b2b_auth";
async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get(COOKIE)?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return name === "관리자" || name === "현석";
}

export async function GET() {
  return NextResponse.json({ ok: true, config: await getDigestConfig() });
}

export async function PUT(req: NextRequest) {
  if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "관리자만 변경할 수 있습니다." }, { status: 403 });
  const b = (await req.json()) as Partial<DigestConfig>;
  return NextResponse.json({ ok: true, config: await saveDigestConfig(b) });
}
