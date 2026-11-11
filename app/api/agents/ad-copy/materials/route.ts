import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getKv } from "@/app/lib/b2b-settings";
import { PENDING_166 } from "@/app/lib/agents/registry";
import { getAdBrief, setAdBrief, listReferences, isPending166 } from "@/app/lib/agents/ad-copy";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max) || null;
async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET — 광고 카피 에이전트가 읽는 자료: 타깃 메모 · 타사 레퍼런스 목록 · 리뷰 현황(공식몰 자동 수집 · 스마트스토어 엑셀 업로드)
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [brief, syncedAt, naverAt] = await Promise.all([getAdBrief(), getKv("shop_reviews_synced_at"), getKv("naver_reviews_uploaded_at")]);
    const count = (ch: string) => sb.from("shop_reviews").select("id", { count: "exact", head: true }).eq("channel", ch);
    try {
      const [references, reviews, naver] = await Promise.all([listReferences(sb), count("공식몰"), count("스마트스토어")]);
      if (reviews.error) throw reviews.error;
      if (naver.error) throw naver.error;
      return NextResponse.json({ ok: true, brief, references, reviews: { count: reviews.count ?? 0, synced_at: syncedAt || null, naver: naver.count ?? 0, naver_at: naverAt || null } });
    } catch (e) {
      if (isPending166(e)) return NextResponse.json({ ok: true, brief, references: [], reviews: { count: 0, synced_at: null, naver: 0, naver_at: null }, pending: PENDING_166 });
      throw e;
    }
  } catch (err) {
    console.error("[agents/ad-copy/materials GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "자료를 불러오지 못했습니다") }, { status: 500 });
  }
}

// PUT { brief } — 타깃 메모 저장
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { brief?: string };
    await setAdBrief(String(b.brief ?? "").trim());
    return NextResponse.json({ ok: true, brief: await getAdBrief() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "타깃 메모를 저장하지 못했습니다") }, { status: 500 });
  }
}

// POST { brand, channel?, url?, copy_text?, note?, images? } — 타사 레퍼런스 추가
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { brand?: string; channel?: string; url?: string; copy_text?: string; note?: string; images?: unknown };
    const brand = clip(b.brand, 100);
    if (!brand) return NextResponse.json({ ok: false, error: "브랜드를 입력하세요." }, { status: 400 });
    const url = clip(b.url, 1000);
    if (url && !/^https?:\/\//i.test(url)) return NextResponse.json({ ok: false, error: "링크는 http 로 시작해야 합니다." }, { status: 400 });
    const images = (Array.isArray(b.images) ? b.images : []).filter((x): x is string => typeof x === "string" && /^https:\/\//.test(x)).slice(0, 4);
    const copy_text = clip(b.copy_text, 3000), note = clip(b.note, 1000);
    if (!url && !copy_text && !note && !images.length) return NextResponse.json({ ok: false, error: "링크·문구·메모·이미지 중 하나는 넣어야 합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("ad_references").insert({ brand, channel: clip(b.channel, 30), url, copy_text, note, images, created_by: await actor(req) });
    if (error) throw error;
    return NextResponse.json({ ok: true, references: await listReferences(sb) });
  } catch (err) {
    if (isPending166(err)) return NextResponse.json({ ok: false, error: PENDING_166 }, { status: 503 });
    console.error("[agents/ad-copy/materials POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "레퍼런스를 저장하지 못했습니다") }, { status: 500 });
  }
}

// DELETE ?id= — 타사 레퍼런스 삭제
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id") || "";
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 레퍼런스입니다." }, { status: 404 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("ad_references").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true, references: await listReferences(sb) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "레퍼런스를 지우지 못했습니다") }, { status: 500 });
  }
}
