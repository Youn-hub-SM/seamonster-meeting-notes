import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { logSalesUploadRevert } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 업로드 배치 되돌리기 — 그 배치가 삽입한 sales_orders 행만 삭제 + 이력 status=reverted.
//  ⚠️ 되돌릴 수 없는 삭제. sales_customers(재구매 판정)는 재집계하지 않음(분석엔 영향 없음).
export async function POST(req: NextRequest) {
  try {
    const { batch_id } = await req.json().catch(() => ({ batch_id: "" }));
    if (!batch_id || typeof batch_id !== "string") return NextResponse.json({ ok: false, error: "batch_id가 필요합니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: batch } = await sb.from("sales_uploads").select("id,filename,status").eq("id", batch_id).maybeSingle();
    if (!batch) return NextResponse.json({ ok: false, error: "해당 업로드 배치를 찾을 수 없습니다." }, { status: 404 });
    if (batch.status === "reverted") return NextResponse.json({ ok: false, error: "이미 되돌린 업로드입니다." }, { status: 409 });

    const { error, count } = await sb.from("sales_orders").delete({ count: "exact" }).eq("upload_batch", batch_id);
    if (error) return NextResponse.json({ ok: false, error: `삭제 오류: ${error.message}` }, { status: 500 });

    await sb.from("sales_uploads").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", batch_id);
    await logSalesUploadRevert(batch.filename || "", batch_id, count ?? 0);
    return NextResponse.json({ ok: true, deleted: count ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
