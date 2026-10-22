import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { getAssistantSettings, setAssistantSettings, getAssistantMonthUsage, kstYm } from "@/app/lib/assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 비서 설정(관리자 › 설정 › AI) — kv: assistant_off("1"/""), assistant_cap_usd(기본 60), assistant_usage_<YYYY-MM>({usd, questions})
const COOKIE = "b2b_auth";
async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get(COOKIE)?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return isAdminName(name);
}

// GET → { ok, off, capUsd, month: { ym, usd, questions } }
export async function GET() {
  try {
    const ym = kstYm();
    const [s, m] = await Promise.all([getAssistantSettings(), getAssistantMonthUsage(ym)]);
    return NextResponse.json({ ok: true, off: s.off, capUsd: s.capUsd, month: { ym, usd: m.usd, questions: m.questions } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { off?: boolean, capUsd?: number } — 관리자만
export async function PUT(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "관리자만 변경할 수 있습니다." }, { status: 403 });
    const b = (await req.json()) as { off?: unknown; capUsd?: unknown };
    const patch: { off?: boolean; capUsd?: number } = {};
    if (b.off !== undefined) patch.off = b.off === true || b.off === "1" || b.off === 1;
    if (b.capUsd !== undefined) {
      const n = Number(b.capUsd);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) return NextResponse.json({ ok: false, error: "월 상한은 1~10,000 달러 사이 숫자여야 합니다." }, { status: 400 });
      patch.capUsd = Math.round(n * 100) / 100;
    }
    if (patch.off === undefined && patch.capUsd === undefined) return NextResponse.json({ ok: false, error: "바꿀 값(off 또는 capUsd)이 없습니다." }, { status: 400 });
    await setAssistantSettings(patch);
    const ym = kstYm();
    const [s, m] = await Promise.all([getAssistantSettings(), getAssistantMonthUsage(ym)]);
    return NextResponse.json({ ok: true, off: s.off, capUsd: s.capUsd, month: { ym, usd: m.usd, questions: m.questions } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
