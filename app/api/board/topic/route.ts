import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { TopicError, topicData } from "@/app/lib/board-topic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 주요 지표 주제 보고서(app/lib/board-topic.ts) — 코드에 정의한 주제(board-types.ts TOPICS) 하나의 숫자.
//  GET ?id=                        → { data } — 오늘 계산해 둔 묶음이 있으면 그대로, 없으면 그 자리에서 계산한다.
//  POST { action: "rebuild", id }  → { data } — 지금 다시 계산한다.
//  로그인한 내부 직원(공장 계정 제외).
async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}
const failRes = (e: unknown, fallback: string) =>
  NextResponse.json({ ok: false, error: e instanceof TopicError ? e.message : extractErrorMsg(e, fallback) }, { status: e instanceof TopicError ? e.status : 500 });

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    return NextResponse.json({ ok: true, data: await topicData(new URL(req.url).searchParams.get("id") || "") });
  } catch (e) {
    return failRes(e, "주제 숫자를 불러오지 못했습니다");
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
    if (body.action !== "rebuild") return NextResponse.json({ ok: false, error: "알 수 없는 요청입니다." }, { status: 400 });
    return NextResponse.json({ ok: true, data: await topicData(String(body.id || ""), { force: true }) });
  } catch (e) {
    return failRes(e, "주제 숫자를 다시 계산하지 못했습니다");
  }
}
