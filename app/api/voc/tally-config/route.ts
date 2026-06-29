import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getTallySecret, setTallySecret, getTallyApiKey, setTallyApiKey, getTallyFormId, setTallyFormId } from "@/app/lib/voc-tally";

export const dynamic = "force-dynamic";

// GET — 연동 상태(비밀값은 노출 안 함)
export async function GET() {
  try {
    const [secret, apiKey, formId] = await Promise.all([getTallySecret(), getTallyApiKey(), getTallyFormId()]);
    return NextResponse.json({ ok: true, hasSecret: !!secret, hasApiKey: !!apiKey, formId: formId || "" });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { secret?, apiKey?, formId? } — 제공된 값만 저장(빈 문자열이면 해제)
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { secret?: string; apiKey?: string; formId?: string };
    if (typeof b.secret === "string") await setTallySecret(b.secret);
    if (typeof b.apiKey === "string") await setTallyApiKey(b.apiKey);
    if (typeof b.formId === "string") await setTallyFormId(b.formId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
