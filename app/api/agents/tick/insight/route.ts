import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { setReviewInsight } from "@/app/lib/agents/ad-copy";

export const dynamic = "force-dynamic";

// POST { text, source? } — 리뷰 분석 자료 올리기. 전체 리뷰를 서버 밖에서 분석한 결과를 넣을 때 쓴다(2026-11-12 첫 분석은 클로드 코드에서 수행).
//  화면(/agents 광고 카피 › 자료)에서 고치는 것과 같은 값을 쓴다 — 마지막에 쓴 쪽이 남는다.
//  미들웨어 밖(matcher 가 api/agents/tick 아래를 통째로 뺀다) — Bearer(업로드 공용 시크릿 또는 CRON_SECRET)가 유일한 문이다.
export async function POST(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const ok = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET].some((k) => !!k && !!k.trim() && authz === `Bearer ${k.trim()}`);
  if (!ok) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  try {
    const b = (await req.json()) as { text?: string; source?: string };
    const text = String(b.text ?? "").trim();
    if (text.length < 200) return NextResponse.json({ ok: false, error: "분석 자료가 비었거나 너무 짧습니다." }, { status: 400 });
    const saved = await setReviewInsight(text, String(b.source || "전체 리뷰 분석").slice(0, 60));
    return NextResponse.json({ ok: true, chars: saved.text.length, updated_at: saved.updated_at });
  } catch (err) {
    console.error("[agents/tick/insight]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "분석 자료를 저장하지 못했습니다") }, { status: 500 });
  }
}
