import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST (multipart: file) — 타사 광고 캡처 이미지 올리기 → { ok, url }
//  광고 카피 에이전트가 이미지 주소로 직접 읽으므로 공개 버킷(추측하기 어려운 경로)에 둔다. 타사가 공개한 광고의 캡처라 비밀이 아니다.
const BUCKET = "ad-references";
const MAX = 5 * 1024 * 1024; // AI 가 읽을 수 있는 이미지 한 장 크기 안쪽
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

let bucketReady = false;
async function ensureBucket(sb: ReturnType<typeof supabaseAdmin>) {
  if (bucketReady) return;
  try { await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX }); } catch { /* 이미 있으면 그대로 */ }
  bucketReady = true;
}

export async function POST(req: NextRequest) {
  try {
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 없습니다." }, { status: 400 });
    if (file.size > MAX) return NextResponse.json({ ok: false, error: "이미지는 5MB 이하만 올릴 수 있습니다." }, { status: 400 });
    let mediaType = (file.type || "").toLowerCase();
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    if (!ALLOWED.includes(mediaType)) return NextResponse.json({ ok: false, error: "jpg·png·webp·gif 이미지만 올릴 수 있습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    await ensureBucket(sb);
    const path = `ref/${Date.now()}-${crypto.randomUUID()}.${mediaType.split("/")[1]}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), { contentType: mediaType, upsert: false });
    if (error) throw error;
    return NextResponse.json({ ok: true, url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl });
  } catch (err) {
    console.error("[agents/ad-copy/photo]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "이미지를 올리지 못했습니다") }, { status: 500 });
  }
}
