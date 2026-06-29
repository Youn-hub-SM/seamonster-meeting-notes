import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/voc/photo  (multipart: file) → 공개 Storage 업로드 → { ok, url }
//  개선요청서에 크게 출력해야 하므로 공개 버킷(랜덤 경로)으로 저장.
const BUCKET = "voc-photos";
const MAX = 10 * 1024 * 1024; // 10MB
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"];

let bucketReady = false;
async function ensureBucket(sb: ReturnType<typeof supabaseAdmin>) {
  if (bucketReady) return;
  try {
    await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX });
  } catch {
    // 이미 존재하면 무시
  }
  bucketReady = true;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "파일이 없습니다." }, { status: 400 });
    }
    if (file.size > MAX) {
      return NextResponse.json({ ok: false, error: "사진은 10MB 이하만 가능합니다." }, { status: 400 });
    }
    let mediaType = (file.type || "").toLowerCase();
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json({ ok: false, error: "이미지(jpg/png/webp) 파일만 가능합니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();
    await ensureBucket(sb);

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = mediaType.split("/")[1] || "jpg";
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const path = `voc/${stamp}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, { contentType: mediaType, upsert: false });
    if (upErr) throw upErr;

    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return NextResponse.json({ ok: true, url: data.publicUrl, path });
  } catch (err) {
    console.error("[voc/photo]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "업로드 실패") }, { status: 500 });
  }
}
