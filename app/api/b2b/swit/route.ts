import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { getB2BSwitConfig, setB2BSwitConfig } from "@/app/lib/b2b-swit";
import { sendSwit } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";

async function isAdmin(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(token)) || resolveUserName(token);
  return isAdminName(name);
}

// GET — B2B Swit 미러 설정 조회. 관리자만.
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdmin(req))) return NextResponse.json({ ok: false, error: "관리자만 접근할 수 있습니다." }, { status: 403 });
    const cfg = await getB2BSwitConfig();
    return NextResponse.json({ ok: true, config: cfg });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 조회 실패") }, { status: 500 });
  }
}

// POST { url, enabled } — 저장. { test: true } 면 저장 없이 테스트 발송. 관리자만.
export async function POST(req: NextRequest) {
  try {
    if (!(await isAdmin(req))) return NextResponse.json({ ok: false, error: "관리자만 접근할 수 있습니다." }, { status: 403 });
    const b = (await req.json()) as { url?: string; enabled?: boolean; test?: boolean };
    const url = String(b.url || "").trim();

    if (b.test) {
      if (!url) return NextResponse.json({ ok: false, error: "웹훅 URL 을 먼저 입력하세요." }, { status: 400 });
      const r = await sendSwit(url, "[씨몬스터 B2B] 테스트 — 이 메시지가 보이면 연동 준비 완료입니다.");
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error || "테스트 발송 실패" }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    // Swit 수신 웹훅 도메인만 허용 — 임의 주소로 내부 데이터가 나가는 것을 막는다.
    if (url && !/^https:\/\/hook\.swit\.io\//.test(url)) {
      return NextResponse.json({ ok: false, error: "Swit 웹훅 주소(https://hook.swit.io/…)만 저장할 수 있습니다." }, { status: 400 });
    }
    await setB2BSwitConfig({ url, enabled: !!b.enabled });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
