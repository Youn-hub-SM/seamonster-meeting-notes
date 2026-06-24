import { NextResponse } from "next/server";
import { getGitbookUrl } from "@/app/lib/site-links";

export const dynamic = "force-dynamic";

// 공개 GET — 네비(전역 헤더 포함, 비B2B 페이지)에서 매뉴얼 링크 URL 을 읽어감.
export async function GET() {
  try {
    const gitbook = await getGitbookUrl();
    return NextResponse.json({ ok: true, gitbook });
  } catch {
    return NextResponse.json({ ok: true, gitbook: "" });
  }
}
