import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/companies/doc?path=biz/xxx.jpg
//  비공개 첨부파일을 보기 위한 단기 서명 URL 발급 (로그인 사용자만 — 미들웨어가 보호).
const BUCKET = "company-docs";

export async function GET(req: NextRequest) {
  try {
    const path = new URL(req.url).searchParams.get("path");
    if (!path) {
      return NextResponse.json({ ok: false, error: "path 가 필요합니다." }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 120); // 2분 유효
    if (error || !data) {
      return NextResponse.json({ ok: false, error: error?.message || "파일을 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, url: data.signedUrl });
  } catch (err) {
    console.error("[b2b/companies/doc]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
