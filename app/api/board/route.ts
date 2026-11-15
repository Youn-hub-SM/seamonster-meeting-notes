import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { BoardBusy, readBoard, isStale, rebuildBoard } from "@/app/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 주요 지표(/board) — 저장된 하루치 묶음을 준다(app/lib/board.ts).
//  GET  → { snapshot, refreshing }. 묶음이 낡았으면(날이 바뀜·매출이 새로 들어옴) 저장된 것을 먼저 주고 응답 뒤에 다시 계산한다.
//          저장된 묶음이 하나도 없을 때만 그 자리에서 계산한다.
//  POST { action: "rebuild" } → 지금 다시 계산해 돌려준다.
//  로그인한 내부 직원(공장 계정 제외).
async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const snap = await readBoard();
    if (!snap) {
      try { return NextResponse.json({ ok: true, snapshot: await rebuildBoard(), refreshing: false }); }
      catch (e) { if (e instanceof BoardBusy) return NextResponse.json({ ok: true, snapshot: null, refreshing: true }); throw e; }
    }
    const stale = await isStale(supabaseAdmin(), snap);
    if (stale) after(() => rebuildBoard().catch((e) => { if (!(e instanceof BoardBusy)) console.warn("[board] 다시 계산 실패", e instanceof Error ? e.message : e); }));
    return NextResponse.json({ ok: true, snapshot: snap, refreshing: stale });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "지표를 불러오지 못했습니다") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "rebuild") return NextResponse.json({ ok: false, error: "알 수 없는 요청입니다." }, { status: 400 });
    return NextResponse.json({ ok: true, snapshot: await rebuildBoard({ manual: true }), refreshing: false });
  } catch (e) {
    if (e instanceof BoardBusy) return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "지표를 다시 계산하지 못했습니다") }, { status: 500 });
  }
}
