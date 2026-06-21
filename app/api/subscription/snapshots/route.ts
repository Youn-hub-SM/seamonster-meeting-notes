import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// 정기배송 분석 결과 스냅샷(KPI만). 개인정보 미포함.

// GET /api/subscription/snapshots — 전체 (오래된→최신 순, 추세 차트용)
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("subscription_snapshots")
      .select("*")
      .order("data_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, snapshots: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST /api/subscription/snapshots — { dataDate?, fileName?, snapshot }
//   dataDate 가 있으면 같은 기준일 행을 갱신(upsert), 없으면 새로 추가.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      dataDate?: string;
      fileName?: string;
      snapshot?: Record<string, unknown>;
    };
    const snapshot = body.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return NextResponse.json({ ok: false, error: "snapshot 이 비어 있습니다." }, { status: 400 });
    }
    const dataDate = (body.dataDate || "").trim() || null;
    const fileName = (body.fileName || "").trim() || null;
    const sb = supabaseAdmin();

    // 같은 기준일이 이미 있으면 갱신
    if (dataDate) {
      const { data: existing, error: exErr } = await sb
        .from("subscription_snapshots")
        .select("id")
        .eq("data_date", dataDate)
        .maybeSingle();
      if (exErr) throw exErr;
      if (existing) {
        const { data, error } = await sb
          .from("subscription_snapshots")
          .update({ snapshot, file_name: fileName, created_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select("*")
          .single();
        if (error) throw error;
        return NextResponse.json({ ok: true, snapshot: data, updated: true });
      }
    }

    const { data, error } = await sb
      .from("subscription_snapshots")
      .insert({ data_date: dataDate, file_name: fileName, snapshot })
      .select("*")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, snapshot: data, updated: false });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// DELETE /api/subscription/snapshots?id=<uuid>
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("subscription_snapshots").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
