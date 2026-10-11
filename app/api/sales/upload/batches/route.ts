import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 최근 웹 업로드 배치(되돌리기 가능한 active 우선). /sales/upload '최근 업로드' 목록용.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const cols = "id,filename,total_rows,inserted,skipped,uploaded_by,status,created_at,reverted_at";
    const first = await sb.from("sales_uploads").select(`${cols},note`).order("created_at", { ascending: false }).limit(20);
    let data: unknown[] | null = first.data;
    let error = first.error;
    if (error && /note/i.test(error.message || "")) {   // 133 미적용 — 메모 칸 없이
      const retry = await sb.from("sales_uploads").select(cols).order("created_at", { ascending: false }).limit(20);
      data = retry.data;
      error = retry.error;
    }
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, batches: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
