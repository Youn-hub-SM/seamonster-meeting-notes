import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { logSalesUploadRevert } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Sb = ReturnType<typeof supabaseAdmin>;

// 이 배치로 태그된 sales_orders 행 수 — 이력의 inserted 는 적용이 중간에 끊기면(시간 초과 등) 실제와 다를 수 있어 직접 센다.
async function countBatch(sb: Sb, batchId: string): Promise<{ rows: number } | { error: string }> {
  const { count, error } = await sb.from("sales_orders").select("id", { count: "exact", head: true }).eq("upload_batch", batchId);
  if (error || count == null) return { error: `행 수 조회 오류: ${error?.message || "건수 없음"}` };
  return { rows: count };
}

async function findBatch(sb: Sb, batchId: string) {
  const { data, error } = await sb.from("sales_uploads").select("id,filename,status").eq("id", batchId).maybeSingle();
  if (error) return { res: NextResponse.json({ ok: false, error: `업로드 이력 조회 오류: ${error.message}` }, { status: 500 }) };
  if (!data) return { res: NextResponse.json({ ok: false, error: "해당 업로드 배치를 찾을 수 없습니다." }, { status: 404 }) };
  if (data.status === "reverted") return { res: NextResponse.json({ ok: false, error: "이미 되돌린 업로드입니다." }, { status: 409 }) };
  return { batch: data as { id: string; filename: string | null; status: string } };
}

// 되돌리기 확인창용 — 지금 이 배치로 남아 있는 행 수(실제로 지워질 수).
export async function GET(req: NextRequest) {
  try {
    const batchId = req.nextUrl.searchParams.get("batch_id") || "";
    if (!batchId) return NextResponse.json({ ok: false, error: "batch_id가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const found = await findBatch(sb, batchId);
    if ("res" in found) return found.res;
    const c = await countBatch(sb, batchId);
    if ("error" in c) return NextResponse.json({ ok: false, error: c.error }, { status: 500 });
    return NextResponse.json({ ok: true, rows: c.rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// 업로드 배치 되돌리기 — 그 배치가 삽입한 sales_orders 행만 삭제 + 이력 status=reverted.
//  되돌릴 수 없는 삭제. sales_customers(재구매 판정)는 재집계하지 않음(분석엔 영향 없음).
//  expect_rows = 확인창에 보인 행 수 — 지금 센 수와 다르면 지우지 않고 409(확인창 숫자 = 실제로 지우는 행).
export async function POST(req: NextRequest) {
  try {
    const { batch_id, expect_rows } = await req.json().catch(() => ({ batch_id: "", expect_rows: undefined }));
    if (!batch_id || typeof batch_id !== "string") return NextResponse.json({ ok: false, error: "batch_id가 필요합니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const found = await findBatch(sb, batch_id);
    if ("res" in found) return found.res;
    const batch = found.batch;

    if (expect_rows != null) {
      const c = await countBatch(sb, batch_id);
      if ("error" in c) return NextResponse.json({ ok: false, error: `${c.error} — 아무것도 지우지 않았습니다.` }, { status: 500 });
      if (Number(expect_rows) !== c.rows) {
        return NextResponse.json({ ok: false, error: `지울 행이 확인 때와 다릅니다(확인 ${Number(expect_rows).toLocaleString()}건 · 지금 ${c.rows.toLocaleString()}건) — 아무것도 지우지 않았습니다. 다시 눌러 확인하세요.` }, { status: 409 });
      }
    }

    const { error, count } = await sb.from("sales_orders").delete({ count: "exact" }).eq("upload_batch", batch_id);
    if (error) return NextResponse.json({ ok: false, error: `삭제 오류: ${error.message}` }, { status: 500 });

    await sb.from("sales_uploads").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", batch_id);
    await logSalesUploadRevert(batch.filename || "", batch_id, count ?? 0);
    return NextResponse.json({ ok: true, deleted: count ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
