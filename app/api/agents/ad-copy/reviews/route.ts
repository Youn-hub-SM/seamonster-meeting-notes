import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { setKv } from "@/app/lib/b2b-settings";
import { PENDING_166 } from "@/app/lib/agents/registry";
import { isPending166 } from "@/app/lib/agents/ad-copy";
import { parseNaverReviewXlsx } from "@/app/lib/agents/naver-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST (multipart: file) — 스마트스토어 리뷰 엑셀 올리기(판매자센터 › 리뷰 관리에서 내려받은 파일) → shop_reviews.
//  같은 리뷰는 리뷰글번호로 겹치지 않는다(다시 올리면 덮어쓴다). 등록자·주문번호는 읽지 않는다.
//  함수가 받을 수 있는 요청 크기 때문에 4MB 까지 — 더 큰 파일은 기간을 나눠 내려받는다.
const MAX = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 없습니다." }, { status: 400 });
    if (file.size > MAX) return NextResponse.json({ ok: false, error: "4MB 이하 파일만 올릴 수 있습니다. 기간을 나눠 내려받으세요." }, { status: 400 });
    let parsed;
    try { parsed = await parseNaverReviewXlsx(await file.arrayBuffer()); }
    catch (e) { return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "엑셀을 읽지 못했습니다." }, { status: 400 }); }
    if (!parsed.rows.length) return NextResponse.json({ ok: false, error: "저장할 리뷰가 없습니다." }, { status: 400 });
    const sb = supabaseAdmin();
    for (let i = 0; i < parsed.rows.length; i += 500) {
      const { error } = await sb.from("shop_reviews").upsert(parsed.rows.slice(i, i + 500), { onConflict: "channel,board_no,article_no" });
      if (error) throw error;
    }
    await setKv("naver_reviews_uploaded_at", new Date().toISOString()).catch(() => {});
    return NextResponse.json({ ok: true, saved: parsed.rows.length, skipped: parsed.skipped });
  } catch (err) {
    if (isPending166(err)) return NextResponse.json({ ok: false, error: PENDING_166 }, { status: 503 });
    console.error("[agents/ad-copy/reviews POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리뷰를 저장하지 못했습니다") }, { status: 500 });
  }
}
