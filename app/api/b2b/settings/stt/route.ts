import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getRtzrClientId, setRtzrClientId,
  getRtzrClientSecret, setRtzrClientSecret,
  getRtzrModel, setRtzrModel,
  testRtzrConnection,
} from "@/app/lib/rtzr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 음성 전사(리턴제로) 설정 — client id/secret 저장과 연결 점검.
//  값 자체는 화면에 돌려주지 않는다(저장 여부만). 아사나 PAT 와 같은 방식.

export async function GET() {
  try {
    const [id, secret, model] = await Promise.all([getRtzrClientId(), getRtzrClientSecret(), getRtzrModel()]);
    return NextResponse.json({ ok: true, hasId: !!id, hasSecret: !!secret, model });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { clientId?, clientSecret? } — 빈 문자열이면 지운다(연동 해제)
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { clientId?: string; clientSecret?: string; model?: string };
    if (typeof b.clientId === "string") await setRtzrClientId(b.clientId);
    if (typeof b.clientSecret === "string") await setRtzrClientSecret(b.clientSecret);
    if (typeof b.model === "string") await setRtzrModel(b.model);
    const [id, secret, model] = await Promise.all([getRtzrClientId(), getRtzrClientSecret(), getRtzrModel()]);
    return NextResponse.json({ ok: true, hasId: !!id, hasSecret: !!secret, model });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST — 연결 점검(토큰 발급 + 용어집 개수)
export async function POST() {
  try {
    const r = await testRtzrConnection();
    return NextResponse.json({ ok: r.ok, lines: r.lines });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "점검 실패") }, { status: 500 });
  }
}
