import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeCrmMessage, type CrmMessageInput } from "@/app/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLS = "id, stage_num, stage, sub, title, status, channel, timing, detail, msg, img_url, links, perf, tags, sort_order, active, created_at, updated_at";

// GET — 전체 메시지(스테이지·순서 정렬)
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("crm_messages")
      .select(COLS)
      .order("stage_num", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, messages: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { ...input } — 신규
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CrmMessageInput;
    const n = normalizeCrmMessage(body);
    if (!n.title && !n.stage) return NextResponse.json({ ok: false, error: "메시지명 또는 스테이지를 입력하세요." }, { status: 400 });
    const { id: _omit, ...row } = n;
    void _omit;
    const { data, error } = await supabaseAdmin().from("crm_messages").insert(row).select(COLS).single();
    if (error) throw error;
    return NextResponse.json({ ok: true, message: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// PUT { id, ...input } — 수정
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as CrmMessageInput;
    if (!body.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const n = normalizeCrmMessage(body);
    const { id, ...row } = n;
    const { data, error } = await supabaseAdmin()
      .from("crm_messages")
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(COLS)
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, message: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE ?id=... — 삭제
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("crm_messages").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
