import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { TopicError, listTopics, saveTopic, deleteTopic, topicData } from "@/app/lib/board-topic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 주요 지표 주제 보고서(app/lib/board-topic.ts) — 조건(상품·페이지·광고 이름에 든 말)으로 정의한 주제의 숫자.
//  GET            → { topics }
//  GET ?id=       → { topic, data } — 오늘 계산해 둔 묶음이 있으면 그대로, 없으면 그 자리에서 계산한다.
//  POST { action: "save", topic } → { topic, topics } / { action: "delete", id } → { topics } / { action: "rebuild", id } → { topic, data }
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
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!id) return NextResponse.json({ ok: true, topics: await listTopics() });
    return NextResponse.json({ ok: true, ...(await topicData(id)) });
  } catch (e) {
    return failRes(e, "주제 숫자를 불러오지 못했습니다");
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string; topic?: unknown };
    if (body.action === "save") return NextResponse.json({ ok: true, ...(await saveTopic(body.topic)) });
    if (body.action === "delete") return NextResponse.json({ ok: true, topics: await deleteTopic(String(body.id || "")) });
    if (body.action === "rebuild") return NextResponse.json({ ok: true, ...(await topicData(String(body.id || ""), { force: true })) });
    return NextResponse.json({ ok: false, error: "알 수 없는 요청입니다." }, { status: 400 });
  } catch (e) {
    return failRes(e, "주제를 처리하지 못했습니다");
  }
}
