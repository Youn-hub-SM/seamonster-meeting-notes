import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeCrmMessage, type CrmMessageInput } from "@/app/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 진행 기간(start/end_date)은 migration 074 — 미적용 DB에선 해당 컬럼만 빼고 동작(기존 폴백 패턴).
const BASE_COLS = "id, stage_num, stage, sub, title, status, channel, timing, detail, msg, img_url, links, perf, tags, sort_order, active, created_at, updated_at";
const COLS = `${BASE_COLS}, start_date, end_date`;
const isMissingDateCols = (err: unknown) => /start_date|end_date/.test(extractErrorMsg(err, ""));

// 저장용 행 — 날짜 ""는 date 컬럼이 거부하므로 null 로. withDates=false 면 컬럼 자체를 뺀다.
function toRow(n: CrmMessageInput, withDates: boolean) {
  const { id: _omit, start_date, end_date, ...rest } = n;
  void _omit;
  return withDates ? { ...rest, start_date: start_date || null, end_date: end_date || null } : rest;
}

// GET — 전체 메시지(스테이지·순서 정렬). datesSupported=false 면 화면이 날짜 기능을 숨긴다.
export async function GET() {
  try {
    const q = (cols: string) => supabaseAdmin().from("crm_messages").select(cols)
      .order("stage_num", { ascending: true }).order("sort_order", { ascending: true }).order("created_at", { ascending: true });
    const first = await q(COLS);
    if (!first.error) return NextResponse.json({ ok: true, datesSupported: true, messages: first.data ?? [] });
    if (!isMissingDateCols(first.error)) throw first.error;
    const legacy = await q(BASE_COLS);
    if (legacy.error) throw legacy.error;
    return NextResponse.json({ ok: true, datesSupported: false, messages: legacy.data ?? [] });
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
    const first = await supabaseAdmin().from("crm_messages").insert(toRow(n, true)).select(COLS).single();
    if (!first.error) return NextResponse.json({ ok: true, message: first.data });
    if (!isMissingDateCols(first.error)) throw first.error;
    const legacy = await supabaseAdmin().from("crm_messages").insert(toRow(n, false)).select(BASE_COLS).single();
    if (legacy.error) throw legacy.error;
    return NextResponse.json({ ok: true, message: legacy.data, datesSupported: false });
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
    const upd = (withDates: boolean, cols: string) => supabaseAdmin().from("crm_messages")
      .update({ ...toRow(n, withDates), updated_at: new Date().toISOString() }).eq("id", body.id!).select(cols).single();
    const first = await upd(true, COLS);
    if (!first.error) return NextResponse.json({ ok: true, message: first.data });
    if (!isMissingDateCols(first.error)) throw first.error;
    const legacy = await upd(false, BASE_COLS);
    if (legacy.error) throw legacy.error;
    return NextResponse.json({ ok: true, message: legacy.data, datesSupported: false });
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
