import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { loadScanMaps, normInvoice } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — 업로드 목록 + 풀 합계
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data: uploads, error } = await sb
      .from("fulfill_scan_uploads")
      .select("id, title, created_by, created_at, invoice_count, item_count")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (057 적용 확인)` }, { status: 500 });
    const { count: poolItems } = await sb.from("fulfill_scan_items").select("id", { count: "exact", head: true });
    return NextResponse.json({ ok: true, uploads: uploads ?? [], poolItemCount: poolItems ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// POST { files: [{ title, rows: [{invoice_no, sku_code, qty}] }] }
//  고객정보(받는분·전화·주소)는 브라우저에서 이미 제거된 상태로 전송된다(파일 자체는 서버로 안 옴).
//     서버는 송장번호·상품코드·수량만 받아 풀에 누적한다.
export async function POST(req: NextRequest) {
  try {
    type InRow = { invoice_no?: unknown; sku_code?: unknown; qty?: unknown };
    type InFile = { title?: string; rows?: InRow[] };
    const { files } = (await req.json()) as { files?: InFile[] };
    if (!Array.isArray(files) || files.length === 0) return NextResponse.json({ ok: false, error: "업로드할 내용이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const actor = await currentActor();
    const { bySku } = await loadScanMaps(sb);

    const results: { name: string; invoiceCount: number; itemCount: number; error?: string }[] = [];
    const unmatched = new Set<string>();
    let okFiles = 0;

    for (const f of files) {
      // 방어적 재정규화(브라우저에서 이미 정규화됐지만 멱등) + 3필드만 채택
      const rows = (Array.isArray(f.rows) ? f.rows : [])
        .map((r) => ({ invoice_no: normInvoice(r.invoice_no), sku_code: String(r.sku_code ?? "").trim(), qty: Math.round(Number(r.qty) || 0) }))
        .filter((r) => r.invoice_no && r.sku_code && r.qty);
      const title = String(f.title || "업로드").slice(0, 200);
      if (rows.length === 0) { results.push({ name: title, invoiceCount: 0, itemCount: 0, error: "유효한 행이 없습니다." }); continue; }

      for (const r of rows) if (!bySku.has(r.sku_code.toUpperCase())) unmatched.add(r.sku_code);
      const invoiceCount = new Set(rows.map((r) => r.invoice_no)).size;

      const { data: up, error: uErr } = await sb
        .from("fulfill_scan_uploads")
        .insert({ title, created_by: actor, invoice_count: invoiceCount, item_count: rows.length })
        .select("id")
        .single();
      if (uErr || !up) { results.push({ name: title, invoiceCount: 0, itemCount: 0, error: `${uErr?.message || "저장 실패"} (057 적용 확인)` }); continue; }

      const CHUNK = 500;
      let insErr: string | null = null;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK).map((r) => ({ upload_id: up.id, invoice_no: r.invoice_no, sku_code: r.sku_code, qty: r.qty }));
        const { error: iErr } = await sb.from("fulfill_scan_items").insert(slice);
        if (iErr) { insErr = iErr.message; break; }
      }
      if (insErr) { await sb.from("fulfill_scan_uploads").delete().eq("id", up.id); results.push({ name: title, invoiceCount: 0, itemCount: 0, error: `라인 저장 실패: ${insErr}` }); continue; }

      okFiles++;
      results.push({ name: title, invoiceCount, itemCount: rows.length });
    }

    return NextResponse.json({
      ok: okFiles > 0,
      error: okFiles === 0 ? "저장된 파일이 없습니다. 파일 형식/열 제목을 확인하세요." : undefined,
      files: results,
      okFiles,
      unmatched: [...unmatched],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "업로드 실패") }, { status: 500 });
  }
}

// DELETE — 풀 전체 비우기(업로드·라인·스캔 이벤트 모두 삭제)
export async function DELETE() {
  try {
    const sb = supabaseAdmin();
    await sb.from("fulfill_scan_events").delete().neq("invoice_no", " ");
    const { error } = await sb.from("fulfill_scan_uploads").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "비우기 실패") }, { status: 500 });
  }
}
