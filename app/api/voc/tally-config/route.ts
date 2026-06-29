import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getTallySecret, setTallySecret } from "@/app/lib/voc-tally";

export const dynamic = "force-dynamic";

// GET — 시크릿 설정 여부(값은 노출 안 함)
export async function GET() {
  try {
    const s = await getTallySecret();
    return NextResponse.json({ ok: true, hasSecret: !!s });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { secret } — 시크릿 저장(빈 값이면 비활성화)
export async function POST(req: NextRequest) {
  try {
    const { secret } = (await req.json()) as { secret?: string };
    await setTallySecret(typeof secret === "string" ? secret : "");
    return NextResponse.json({ ok: true, hasSecret: !!(secret && secret.trim()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
