import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { parseScanCells, parseCsv, loadScanMaps } from "@/app/lib/fulfill-scan";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cellVal(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return o.result ?? "";
    if ("text" in o) return o.text ?? "";
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
  }
  return v;
}

async function xlsxToCells(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const cells: unknown[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const arr: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) arr.push(cellVal(ws.getRow(r).getCell(c)));
    cells.push(arr);
  }
  return cells;
}

// GET — 최근 배치 목록(+ 각 배치 스캔 진행수)
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data: batches, error } = await sb
      .from("fulfill_scan_batches")
      .select("id, title, created_by, created_at, closed, invoice_count, item_count, note")
      .order("created_at", { ascending: false })
      .limit(40);
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (057 적용 확인)` }, { status: 500 });
    const ids = (batches ?? []).map((b) => b.id);
    const scannedByBatch = new Map<string, number>();
    if (ids.length) {
      const { data: ev } = await sb.from("fulfill_scan_events").select("batch_id").in("batch_id", ids);
      for (const e of ev ?? []) scannedByBatch.set(e.batch_id, (scannedByBatch.get(e.batch_id) || 0) + 1);
    }
    const rows = (batches ?? []).map((b) => ({ ...b, scanned_count: scannedByBatch.get(b.id) || 0 }));
    return NextResponse.json({ ok: true, batches: rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// POST (multipart: file, title?) — 파일 파싱 → 배치 + 라인 저장
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const titleIn = String(form.get("title") || "").trim();
    if (!file) return NextResponse.json({ ok: false, error: "파일을 첨부하세요." }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    const isCsv = /\.csv$/i.test(file.name) || file.type.includes("csv");
    const cells = isCsv ? parseCsv(buf.toString("utf-8")) : await xlsxToCells(buf);
    const parsed = parseScanCells(cells);
    if (parsed.error) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    if (parsed.rows.length === 0) return NextResponse.json({ ok: false, error: "읽을 데이터 행이 없습니다." }, { status: 400 });

    // 미매칭(상품마스터에 없는 단품코드) 집계
    const { bySku } = await loadScanMaps(supabaseAdmin());
    const unmatchedSet = new Set<string>();
    for (const r of parsed.rows) if (!bySku.has(r.sku_code.trim().toUpperCase())) unmatchedSet.add(r.sku_code.trim());

    const sb = supabaseAdmin();
    const actor = await currentActor();
    const d = new Date(Date.now() + 9 * 3600e3);
    const title = titleIn || file.name.replace(/\.(xlsx|xls|csv)$/i, "") || `스캔 ${d.toISOString().slice(0, 10)}`;

    const { data: batch, error: bErr } = await sb
      .from("fulfill_scan_batches")
      .insert({ title, created_by: actor, invoice_count: parsed.invoiceCount, item_count: parsed.itemCount })
      .select("id, title, created_by, created_at, invoice_count, item_count")
      .single();
    if (bErr || !batch) return NextResponse.json({ ok: false, error: `${bErr?.message || "배치 생성 실패"} (057 적용 확인)` }, { status: 500 });

    // 라인 저장(청크)
    const CHUNK = 500;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const slice = parsed.rows.slice(i, i + CHUNK).map((r) => ({ batch_id: batch.id, invoice_no: r.invoice_no, sku_code: r.sku_code, qty: r.qty }));
      const { error: iErr } = await sb.from("fulfill_scan_items").insert(slice);
      if (iErr) {
        await sb.from("fulfill_scan_batches").delete().eq("id", batch.id); // 롤백
        return NextResponse.json({ ok: false, error: `라인 저장 실패: ${iErr.message}` }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true,
      batch,
      invoiceCount: parsed.invoiceCount,
      itemCount: parsed.itemCount,
      excludedNothing: parsed.excludedNothing,
      unmatched: [...unmatchedSet],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "업로드 실패") }, { status: 500 });
  }
}
