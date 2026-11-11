import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { setKv } from "@/app/lib/b2b-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST — 공식몰 리뷰 올리기. 중계 서버(scripts/cafe24-review-sync.mjs)가 카페24 게시판 API 로 읽은 리뷰를 보낸다(migration 166 shop_reviews).
//  body: { channel?: "공식몰"(기본) | "스마트스토어", reviews: [{ board_no, article_no, product_no?, product_name?, rating?, title?, content?, has_photo?, written_at? }] }
//  작성자 이름·아이디·연락처는 받지 않는다 — 들어와도 아래에서 고른 칸만 저장한다.
//  미들웨어 밖(matcher 가 api/agents/tick 아래를 통째로 뺀다) — Bearer(업로드 공용 시크릿 또는 CRON_SECRET)가 유일한 문이다.
type In = { board_no?: number; article_no?: number; product_no?: number | null; product_name?: string | null; rating?: number | null; title?: string | null; content?: string | null; has_photo?: boolean; written_at?: string | null };
const text = (v: unknown, max: number) => { const t = String(v ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim(); return t ? t.slice(0, max) : null; };

export async function POST(req: NextRequest) {
  const authz = req.headers.get("authorization") || "";
  const ok = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET].some((k) => !!k && !!k.trim() && authz === `Bearer ${k.trim()}`);
  if (!ok) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  try {
    const b = (await req.json()) as { reviews?: In[]; channel?: string };
    const channel = b.channel === "스마트스토어" ? "스마트스토어" : "공식몰"; // 스마트스토어 = 리뷰 엑셀을 서버 밖에서 읽어 올릴 때(파일이 4MB 를 넘는 첫 적재)
    const now = new Date().toISOString();
    const rows = (Array.isArray(b.reviews) ? b.reviews : [])
      .filter((r) => r && Number.isInteger(Number(r.board_no)) && Number.isInteger(Number(r.article_no)))
      .map((r) => {
        const rating = Number(r.rating), at = Date.parse(String(r.written_at || ""));
        return {
          channel, board_no: Number(r.board_no), article_no: Number(r.article_no),
          product_no: r.product_no != null && Number.isFinite(Number(r.product_no)) ? Number(r.product_no) : null,
          product_name: text(r.product_name, 200), rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
          title: text(r.title, 200), content: text(r.content, 4000), has_photo: !!r.has_photo,
          written_at: Number.isFinite(at) ? new Date(at).toISOString() : null, synced_at: now,
        };
      });
    if (!rows.length) return NextResponse.json({ ok: false, error: "리뷰 데이터가 비었습니다." }, { status: 400 });
    const sb = supabaseAdmin();
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("shop_reviews").upsert(rows.slice(i, i + 500), { onConflict: "channel,board_no,article_no" });
      if (error) throw error;
    }
    await setKv(channel === "공식몰" ? "shop_reviews_synced_at" : "naver_reviews_uploaded_at", now).catch(() => {});
    return NextResponse.json({ ok: true, saved: rows.length });
  } catch (err) {
    console.error("[agents/tick/reviews]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리뷰를 저장하지 못했습니다") }, { status: 500 });
  }
}
