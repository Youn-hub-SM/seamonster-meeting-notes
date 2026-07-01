import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // 헷갈리는 문자(0,o,1,l,i) 제외
function genCode(len = 6) {
  const b = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
const normUrl = (u: string) => { const t = (u || "").trim(); return t ? (/^https?:\/\//i.test(t) ? t : `https://${t}`) : ""; };
const isValidUrl = (u: string) => { try { new URL(u); return true; } catch { return false; } };
// 캠페인명 코드 허용 — 한글/영문/숫자/-/_ OK. URL 깨는 문자·공백만 정리(공백→'-'). 대소문자는 보존.
const cleanCode = (c: string) => (c || "").trim().replace(/\s+/g, "-").replace(/[/\\?#%&+<>"'`.]/g, "").slice(0, 64);

async function actor(req: NextRequest) {
  const t = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(t)) || resolveUserName(t);
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("short_links")
      .select("id, code, target_url, title, active, scan_count, created_by, created_at")
      .order("created_at", { ascending: false }).limit(1000);
    if (error) throw error;
    return NextResponse.json({ ok: true, links: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { target_url?: string; title?: string; code?: string };
    const target = normUrl(String(b.target_url || ""));
    if (!target || !isValidUrl(target)) return NextResponse.json({ ok: false, error: "올바른 목적지 URL 을 입력하세요." }, { status: 400 });
    const title = (b.title || "").trim() || null;
    const custom = cleanCode(String(b.code || ""));
    const sb = supabaseAdmin();
    const by = await actor(req);
    for (let attempt = 0; attempt < 6; attempt++) {
      const c = custom || genCode();
      const { data, error } = await sb.from("short_links").insert({ code: c, target_url: target, title, created_by: by }).select().single();
      if (!error) return NextResponse.json({ ok: true, link: data });
      if (/duplicate|unique/i.test(error.message)) {
        if (custom) return NextResponse.json({ ok: false, error: `코드 '${custom}' 는 이미 사용 중입니다.` }, { status: 409 });
        continue; // 랜덤 충돌 → 재시도
      }
      throw error;
    }
    return NextResponse.json({ ok: false, error: "코드 생성 실패(재시도)" }, { status: 500 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "생성 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { id?: string; target_url?: string; title?: string; active?: boolean; code?: string };
    if (!b.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.target_url !== undefined) { const t = normUrl(String(b.target_url)); if (!isValidUrl(t)) return NextResponse.json({ ok: false, error: "올바른 URL 이 아닙니다." }, { status: 400 }); row.target_url = t; }
    if (b.title !== undefined) row.title = String(b.title).trim() || null;
    if (b.active !== undefined) row.active = !!b.active;
    if (b.code !== undefined) { const c = cleanCode(String(b.code)); if (!c) return NextResponse.json({ ok: false, error: "코드가 비었습니다." }, { status: 400 }); row.code = c; }
    const { error } = await supabaseAdmin().from("short_links").update(row).eq("id", b.id);
    if (error) { if (/duplicate|unique/i.test(error.message)) return NextResponse.json({ ok: false, error: "코드가 중복됩니다." }, { status: 409 }); throw error; }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("short_links").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
