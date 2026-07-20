import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeCrmMessage, type CrmMessageInput } from "@/app/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 선택 컬럼 폴백(기존 패턴: 에러에 컬럼명이 보이면 그 컬럼 빼고 재시도):
//  start/end_date = migration 074 · customer/msg_type = migration 077.
//  단계: 전체 → 077 제외 → 074도 제외. 응답 플래그로 화면이 해당 입력만 숨긴다.
const BASE_COLS = "id, stage_num, stage, sub, title, status, channel, timing, detail, msg, img_url, links, perf, tags, sort_order, active, created_at, updated_at";
const TIERS = [
  { cols: `${BASE_COLS}, start_date, end_date, customer, msg_type`, dates: true, fields: true },
  { cols: `${BASE_COLS}, start_date, end_date`, dates: true, fields: false },
  { cols: BASE_COLS, dates: false, fields: false },
] as const;
const missing = (err: unknown) => {
  const m = extractErrorMsg(err, "");
  return { fields: /customer|msg_type/.test(m), dates: /start_date|end_date/.test(m) };
};

// 저장용 행 — 날짜 ""는 date 컬럼이 거부하므로 null 로. 미적용 컬럼은 키 자체를 뺀다.
function toRow(n: CrmMessageInput, tier: (typeof TIERS)[number]) {
  const { id: _omit, start_date, end_date, customer, msg_type, ...rest } = n;
  void _omit;
  return {
    ...rest,
    ...(tier.dates ? { start_date: start_date || null, end_date: end_date || null } : {}),
    ...(tier.fields ? { customer, msg_type } : {}),
  };
}

const flags = (tier: (typeof TIERS)[number]) => ({ datesSupported: tier.dates, fieldsSupported: tier.fields });

// GET — 전체 메시지(스테이지·순서 정렬)
export async function GET() {
  try {
    let lastErr: unknown = null;
    for (const tier of TIERS) {
      const { data, error } = await supabaseAdmin().from("crm_messages").select(tier.cols)
        .order("stage_num", { ascending: true }).order("sort_order", { ascending: true }).order("created_at", { ascending: true });
      if (!error) return NextResponse.json({ ok: true, ...flags(tier), messages: data ?? [] });
      lastErr = error;
      const miss = missing(error);
      if (!miss.fields && !miss.dates) throw error; // 컬럼 문제가 아니면 즉시 실패
    }
    throw lastErr;
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
    let lastErr: unknown = null;
    for (const tier of TIERS) {
      const { data, error } = await supabaseAdmin().from("crm_messages").insert(toRow(n, tier)).select(tier.cols).single();
      if (!error) return NextResponse.json({ ok: true, ...flags(tier), message: data });
      lastErr = error;
      const miss = missing(error);
      if (!miss.fields && !miss.dates) throw error;
    }
    throw lastErr;
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
    let lastErr: unknown = null;
    for (const tier of TIERS) {
      const { data, error } = await supabaseAdmin().from("crm_messages")
        .update({ ...toRow(n, tier), updated_at: new Date().toISOString() }).eq("id", body.id).select(tier.cols).single();
      if (!error) return NextResponse.json({ ok: true, ...flags(tier), message: data });
      lastErr = error;
      const miss = missing(error);
      if (!miss.fields && !miss.dates) throw error;
    }
    throw lastErr;
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
