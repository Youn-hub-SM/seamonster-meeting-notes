import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getGitbookUrl, setGitbookUrl } from "@/app/lib/site-links";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, gitbook: await getGitbookUrl() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { url } — 매뉴얼(GitBook) 링크 저장 (빈 값이면 해제)
export async function PUT(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url?: string };
    const u = (url || "").trim();
    if (u && !/^https?:\/\//i.test(u)) {
      return NextResponse.json({ ok: false, error: "http(s):// 로 시작하는 URL이어야 합니다." }, { status: 400 });
    }
    await setGitbookUrl(u);
    return NextResponse.json({ ok: true, gitbook: u });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
