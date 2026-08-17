import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { shortLinkCode } from "@/app/lib/ig-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type IgRuleInput = {
  id?: string;
  ig_user_id: string;
  media_id: string;
  media_permalink?: string;
  media_caption?: string;
  keyword?: string;
  message: string;
  link?: string;
  active?: boolean;
  start_at?: string | null; // ISO(+09:00 포함) 또는 null
  end_at?: string | null;
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const toTs = (v: unknown): string | null => {
  const s = clean(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function normalize(b: IgRuleInput) {
  return {
    ig_user_id: clean(b.ig_user_id),
    media_id: clean(b.media_id),
    media_permalink: clean(b.media_permalink),
    media_caption: clean(b.media_caption).slice(0, 120),
    keyword: clean(b.keyword),
    message: clean(b.message),
    link: clean(b.link),
    active: b.active !== false,
    start_at: toTs(b.start_at),
    end_at: toTs(b.end_at),
  };
}

// GET — 규칙 전체 + 규칙별 발송수(성공/실패) + 브랜드링크 클릭수(link 가 link.seamonster.kr/코드일 때)
export async function GET() {
  try {
    const db = supabaseAdmin();
    const [{ data: rules, error }, { data: logRows, error: logErr }] = await Promise.all([
      db.from("ig_dm_rules").select("*").order("created_at", { ascending: false }),
      db.from("ig_dm_logs").select("rule_id, status"),
    ]);
    if (error) throw error;
    if (logErr) throw logErr;

    const sent: Record<string, number> = {}; const failed: Record<string, number> = {};
    for (const l of logRows || []) {
      const k = String(l.rule_id || "");
      if (!k) continue;
      if (l.status === "sent") sent[k] = (sent[k] || 0) + 1; else failed[k] = (failed[k] || 0) + 1;
    }

    // 클릭수 — 규칙 링크의 브랜드링크 코드 → short_links.scan_count (있는 것만, 한 번에 조회)
    const codes = [...new Set((rules || []).map((r) => shortLinkCode(r.link)).filter(Boolean))];
    const clicks: Record<string, number> = {};
    if (codes.length > 0) {
      const { data: links } = await db.from("short_links").select("code, scan_count").in("code", codes);
      for (const l of links || []) clicks[l.code] = l.scan_count || 0;
    }

    return NextResponse.json({
      ok: true,
      rules: (rules || []).map((r) => ({
        ...r,
        sent: sent[r.id] || 0,
        failed: failed[r.id] || 0,
        clicks: shortLinkCode(r.link) ? clicks[shortLinkCode(r.link)] ?? 0 : null, // null = 브랜드링크 아님(집계 불가)
      })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST — 신규
export async function POST(req: NextRequest) {
  try {
    const n = normalize((await req.json()) as IgRuleInput);
    if (!n.ig_user_id || !n.media_id) return NextResponse.json({ ok: false, error: "계정과 게시물을 선택하세요." }, { status: 400 });
    if (!n.message) return NextResponse.json({ ok: false, error: "보낼 메시지를 입력하세요." }, { status: 400 });
    if (n.start_at && n.end_at && n.start_at > n.end_at) return NextResponse.json({ ok: false, error: "종료가 시작보다 빠릅니다." }, { status: 400 });
    const { data, error } = await supabaseAdmin().from("ig_dm_rules").insert(n).select("*").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, rule: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// PUT { id, ... } — 수정(활성 토글 포함)
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as IgRuleInput;
    if (!body.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const n = normalize(body);
    if (n.start_at && n.end_at && n.start_at > n.end_at) return NextResponse.json({ ok: false, error: "종료가 시작보다 빠릅니다." }, { status: 400 });
    const { data, error } = await supabaseAdmin().from("ig_dm_rules")
      .update({ ...n, updated_at: new Date().toISOString() }).eq("id", body.id).select("*").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, rule: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE ?id=...
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("ig_dm_rules").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
