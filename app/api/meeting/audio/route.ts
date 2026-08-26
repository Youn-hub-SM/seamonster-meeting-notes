import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 회의 녹음 파일 업로드 창구 — 서명 URL 만 내주고, 파일 자체는 브라우저가 Storage 로 직접 올린다.
//  서버를 거치면 Vercel 요청 본문 4.5MB 제한에 걸린다(2시간 녹음은 수십MB). 그래서 경로만 오간다.
//  올라간 파일은 전사 요청 직후 지운다(/api/meeting/transcribe) — 남겨둘 이유가 없다.

const BUCKET = "meeting-audio";
const MAX_BYTES = 300 * 1024 * 1024; // 리턴제로 상한은 2GB 지만, 회의 녹음이 이보다 크면 뭔가 잘못된 것

const COOKIE = "b2b_auth";
async function userOf(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

// POST { filename, size } — 업로드용 서명 URL 발급
export async function POST(req: NextRequest) {
  try {
    const user = await userOf(req);
    if (!user) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });

    const b = (await req.json()) as { filename?: string; size?: number };
    const size = Number(b.size) || 0;
    if (size <= 0) return NextResponse.json({ ok: false, error: "파일 크기를 확인하지 못했습니다." }, { status: 400 });
    if (size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `파일이 너무 큽니다 (${Math.round(size / 1024 / 1024)}MB). 300MB 이하로 올려주세요.` },
        { status: 400 },
      );
    }

    const sb = supabaseAdmin();
    try { await sb.storage.createBucket(BUCKET, { public: false }); } catch { /* 이미 있으면 그대로 */ }

    // 확장자만 살려 새 이름을 만든다 — 원본 파일명에 회의 정보가 담겨 있을 수 있어 경로에 남기지 않는다.
    const ext = (String(b.filename || "").match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] || "m4a").toLowerCase();
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const path = `${stamp}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new Error(error?.message || "업로드 URL 생성 실패");

    return NextResponse.json({ ok: true, path: data.path, uploadUrl: data.signedUrl });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "업로드 준비 실패") }, { status: 500 });
  }
}

// DELETE { path } — 취소·실패 시 정리
export async function DELETE(req: NextRequest) {
  try {
    const user = await userOf(req);
    if (!user) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const b = (await req.json()) as { path?: string };
    const path = String(b.path || "").trim();
    if (!path) return NextResponse.json({ ok: false, error: "경로가 없습니다." }, { status: 400 });
    await supabaseAdmin().storage.from(BUCKET).remove([path]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
