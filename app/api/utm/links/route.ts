import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_LINKS = 100;

// GET /api/utm/links — 최근 생성 히스토리 (최신순, 최대 100)
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("utm_links")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(MAX_LINKS);
    if (error) throw error;
    return NextResponse.json({ ok: true, links: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST /api/utm/links — 히스토리 1건 추가. body 는 camelCase 클라이언트 형태.
//   { baseUrl, source, medium, campaign, content, term, note, fullUrl, dedupe? }
//   dedupe=true 이고 가장 최근 항목과 fullUrl 이 같으면 추가하지 않고 그 항목을 반환.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const fullUrl = str(b.fullUrl);
    if (!fullUrl) {
      return NextResponse.json({ ok: false, error: "URL 이 비어 있습니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();

    if (b.dedupe) {
      const { data: latest } = await sb
        .from("utm_links")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest && latest.full_url === fullUrl) {
        return NextResponse.json({ ok: true, link: latest, deduped: true });
      }
    }

    const row = {
      base_url: str(b.baseUrl),
      source: str(b.source),
      medium: str(b.medium),
      campaign: str(b.campaign),
      content: str(b.content),
      term: str(b.term),
      note: str(b.note),
      full_url: fullUrl,
    };
    const { data, error } = await sb.from("utm_links").insert(row).select("*").single();
    if (error) throw error;

    // 100건 초과분 정리 (오래된 것부터)
    const { data: overflow } = await sb
      .from("utm_links")
      .select("id")
      .order("created_at", { ascending: false })
      .range(MAX_LINKS, MAX_LINKS + 200);
    if (overflow && overflow.length) {
      await sb.from("utm_links").delete().in("id", overflow.map((r) => r.id));
    }

    return NextResponse.json({ ok: true, link: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// DELETE /api/utm/links?id=<uuid>  또는  ?all=1
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const all = searchParams.get("all");
    const sb = supabaseAdmin();

    if (all === "1") {
      const { error } = await sb.from("utm_links").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (!id) {
      return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    }
    const { error } = await sb.from("utm_links").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
