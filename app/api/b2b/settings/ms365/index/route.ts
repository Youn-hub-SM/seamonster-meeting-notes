import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { adminOnly } from "@/app/lib/admin-req";
import { isMsConfigured } from "@/app/lib/msgraph";
import { reindexNow } from "@/app/lib/ms365-docs";
import { lastIndexRun } from "@/app/lib/ms365-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — 마지막 색인 요약
export async function GET(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  return NextResponse.json({ ok: true, last: await lastIndexRun() });
}

// POST — 문서 색인 갱신(관리자). 시간 예산 45초 안에서 바뀐 파일만 읽는다. 남으면 다음 실행(크론·버튼)이 이어서.
export async function POST(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    if (!isMsConfigured()) return NextResponse.json({ ok: false, error: "Vercel 환경 변수 MS_TENANT_ID·MS_CLIENT_ID·MS_CLIENT_SECRET 가 없습니다(docs/ms365-setup.md)." }, { status: 400 });
    const s = await reindexNow({ budgetMs: 45_000 });
    return NextResponse.json({ ok: true, summary: s });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "색인 갱신 실패") }, { status: 500 });
  }
}
