import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 최근 웹 업로드 배치(되돌리기 가능한 active 우선). /sales/upload '최근 업로드' 목록용.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("sales_uploads")
      .select("id,filename,total_rows,inserted,skipped,uploaded_by,status,created_at,reverted_at")
      .order("created_at", { ascending: false }).limit(20);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, batches: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
