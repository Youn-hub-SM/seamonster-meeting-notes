import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

const FIELDS = ["received_at", "source", "channel", "customer", "product", "category", "content", "sentiment", "status", "assignee", "resolution", "loss_amount"] as const;

function pick(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (body[f] !== undefined) out[f] = body[f] === "" ? null : body[f];
  if (out.loss_amount != null) out.loss_amount = Math.max(0, Math.round(Number(out.loss_amount) || 0));
  return out;
}

// GET /api/voc?status=&source=&q= — 목록
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let q = supabaseAdmin().from("voc").select("*").order("received_at", { ascending: false }).order("created_at", { ascending: false });
    const status = sp.get("status");
    const source = sp.get("source");
    const search = sp.get("q");
    if (status) q = q.eq("status", status);
    if (source) q = q.eq("source", source);
    if (search) q = q.or(`content.ilike.%${search}%,customer.ilike.%${search}%,product.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ ok: true, rows: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST — 등록
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const row = pick(body);
    if (!row.content || String(row.content).trim() === "") {
      return NextResponse.json({ ok: false, error: "내용을 입력하세요." }, { status: 400 });
    }
    const { data, error } = await supabaseAdmin().from("voc").insert(row).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// PATCH { id, ...fields } — 수정(상태 변경 포함)
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown> & { id?: string };
    if (!body.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const row = { ...pick(body), updated_at: new Date().toISOString() };
    const { data, error } = await supabaseAdmin().from("voc").update(row).eq("id", body.id).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE ?id=
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("voc").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
