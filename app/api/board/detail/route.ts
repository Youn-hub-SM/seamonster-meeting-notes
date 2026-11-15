import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { boardDetail } from "@/app/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 주요 지표 — 고른 기간의 상품별 표와 신규·재구매 고객 수(날마다 더할 수 없는 값). Supabase 만 읽는다.
//  GET ?from=YYYY-MM-DD&to=YYYY-MM-DD[&ch=공식몰,스마트스토어] → { detail }
//  채널 필터는 상품별 표에만 걸린다(신규·재구매는 전체 채널 — 고객은 채널을 넘나든다).
//  로그인한 내부 직원(공장 계정 제외).
export async function GET(req: NextRequest) {
  try {
    const t = req.cookies.get("b2b_auth")?.value;
    const sess = await verifySessionFull(t);
    const name = sess ? (sess.role === "factory" ? null : sess.name) : resolveUserName(t) || null;
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sp = new URL(req.url).searchParams;
    const ch = (sp.get("ch") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const detail = await boardDetail(supabaseAdmin(), sp.get("from") || "", sp.get("to") || "", ch);
    return NextResponse.json({ ok: true, detail });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "기간 상세를 불러오지 못했습니다") }, { status: 500 });
  }
}
