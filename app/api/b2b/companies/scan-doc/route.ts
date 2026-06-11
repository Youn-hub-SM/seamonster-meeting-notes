import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { extractBizDoc } from "@/app/lib/b2b-bizdoc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/b2b/companies/scan-doc  (multipart: file)
//  사업자등록증 업로드 → 비공개 Storage 저장 + Claude 로 필드 추출.
//  응답: { ok, path, fields, extractError? }
const BUCKET = "company-docs";
const MAX = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "파일이 없습니다." }, { status: 400 });
    }
    if (file.size > MAX) {
      return NextResponse.json({ ok: false, error: "파일은 5MB 이하만 가능합니다." }, { status: 400 });
    }
    let mediaType = file.type || "";
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json({ ok: false, error: "이미지(jpg/png) 또는 PDF만 가능합니다." }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const base64 = buf.toString("base64");

    // 1) Storage 업로드 (비공개)
    const sb = supabaseAdmin();
    const ext = mediaType === "application/pdf" ? "pdf" : mediaType.split("/")[1];
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const path = `biz/${stamp}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, {
      contentType: mediaType,
      upsert: false,
    });
    if (upErr) throw upErr;

    // 2) Claude 추출 (실패해도 파일은 첨부됨)
    let fields = null;
    let extractError: string | null = null;
    try {
      fields = await extractBizDoc(base64, mediaType);
    } catch (err) {
      extractError = extractErrorMsg(err, "자동 인식 실패");
      console.error("[b2b/companies/scan-doc extract]", err);
    }

    return NextResponse.json({ ok: true, path, fields, extractError });
  } catch (err) {
    console.error("[b2b/companies/scan-doc]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "업로드 실패") },
      { status: 500 }
    );
  }
}
