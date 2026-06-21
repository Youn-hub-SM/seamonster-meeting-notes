import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { fetchManualEntries, CsManualInput } from "@/app/lib/cs-manual";

export const dynamic = "force-dynamic";

// GET /api/cs/manual — 매뉴얼 항목 목록 (비어 있으면 기본값 자동 시드)
export async function GET() {
  try {
    const entries = await fetchManualEntries();
    return NextResponse.json({ ok: true, entries });
  } catch (err) {
    console.error("[cs/manual GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST /api/cs/manual — 항목 추가
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CsManualInput;
    if (!body.title?.trim()) {
      return NextResponse.json({ ok: false, error: "제목을 입력하세요." }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("cs_manual")
      .insert({
        title: body.title.trim(),
        content: (body.content ?? "").trim(),
        sort_order: Number(body.sort_order) || 999,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, entry: data });
  } catch (err) {
    console.error("[cs/manual POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "추가 실패") }, { status: 500 });
  }
}

// PUT /api/cs/manual — 항목 수정
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as CsManualInput & { id: string };
    if (!body.id) return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });
    if (!body.title?.trim()) {
      return NextResponse.json({ ok: false, error: "제목을 입력하세요." }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("cs_manual")
      .update({
        title: body.title.trim(),
        content: (body.content ?? "").trim(),
        sort_order: Number(body.sort_order) || 999,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.id)
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, entry: data });
  } catch (err) {
    console.error("[cs/manual PUT]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE /api/cs/manual?id=...
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("cs_manual").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cs/manual DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
