import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { startTranscribe, getTranscribe } from "@/app/lib/rtzr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Storage 에서 받아 리턴제로로 넘기는 전송 시간

// 녹음 파일 전사 — 리턴제로에 넘기고(POST), 완료될 때까지 화면이 상태를 물어본다(GET).
//  파일은 브라우저가 Storage 에 올려두고 경로만 넘어온다(/api/meeting/audio).
//  리턴제로가 파일을 받은 직후 Storage 에서 지운다 — 오디오를 우리 쪽에 남기지 않는다.

const BUCKET = "meeting-audio";

const COOKIE = "b2b_auth";
async function userOf(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

const MIME: Record<string, string> = {
  m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg",
  wav: "audio/wav", flac: "audio/flac", amr: "audio/amr",
};

// POST { path, spkCount? } — 전사 시작
export async function POST(req: NextRequest) {
  let path = "";
  try {
    const user = await userOf(req);
    if (!user) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });

    const b = (await req.json()) as { path?: string; spkCount?: number };
    path = String(b.path || "").trim();
    if (!path) return NextResponse.json({ ok: false, error: "업로드된 파일을 찾지 못했습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(path);
    if (dlErr || !blob) throw new Error(dlErr?.message || "업로드된 파일을 읽지 못했습니다.");

    const ext = (path.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] || "m4a").toLowerCase();
    const buf = await blob.arrayBuffer();

    const r = await startTranscribe(
      { buf, filename: `meeting.${ext}`, contentType: MIME[ext] || "application/octet-stream" },
      { spkCount: b.spkCount ?? null },
    );

    // 리턴제로가 파일을 받았으므로 우리 쪽 사본은 더 필요 없다(실패해도 마찬가지 — 재시도는 다시 올린다).
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});

    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
    return NextResponse.json({ ok: true, id: r.id });
  } catch (err) {
    if (path) await supabaseAdmin().storage.from(BUCKET).remove([path]).catch(() => {});
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "전사 요청 실패") }, { status: 500 });
  }
}

// GET ?id= — 상태 조회. 완료되면 화자별로 묶인 텍스트를 준다.
export async function GET(req: NextRequest) {
  try {
    const user = await userOf(req);
    if (!user) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });

    const id = req.nextUrl.searchParams.get("id")?.trim();
    if (!id) return NextResponse.json({ ok: false, error: "조회할 작업 번호가 없습니다." }, { status: 400 });

    const r = await getTranscribe(id);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
    if (r.status === "transcribing") return NextResponse.json({ ok: true, done: false });
    return NextResponse.json({ ok: true, done: true, text: r.text, speakers: r.speakers, seconds: r.seconds });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "상태 조회 실패") }, { status: 500 });
  }
}
