import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?q=&limit= — 코드표 목록 + 총 개수
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") || "").trim();
    const limit = Math.min(2000, Math.max(1, Number(sp.get("limit")) || 500));
    const sb = supabaseAdmin();
    const { count } = await sb.from("shipping_codes").select("*", { count: "exact", head: true });
    let query = sb.from("shipping_codes").select("sku, courier_name, order_weight, updated_at").order("sku").limit(limit);
    if (q) query = query.or(`sku.ilike.%${q.replace(/[%_]/g, " ")}%,courier_name.ilike.%${q.replace(/[%_]/g, " ")}%`);
    const { data, error } = await query;
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (053 적용 확인)` }, { status: 500 });
    return NextResponse.json({ ok: true, total: count ?? 0, rows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

function cellStr(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return String(o.result ?? "");
    if ("text" in o) return String(o.text ?? "");
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
  }
  return String(v);
}

// POST (multipart: file) — 'code' 탭(코드명·상품명·주문당 총 중량) 업로드 → shipping_codes upsert.
//  헤더로 열을 찾음: 코드/SKU=sku, 상품명/품목명=courier_name, '총 중량'=order_weight.
export async function POST(req: NextRequest) {
  try {
    const file = (await req.formData()).get("file") as File | null;
    if (!file) return NextResponse.json({ ok: false, error: "엑셀을 첨부하세요." }, { status: 400 });
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(await file.arrayBuffer());
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets.find((w) => w.name === "code") || wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    // 헤더 매핑
    const header = ws.getRow(1);
    let skuCol = 0, nameCol = 0, wCol = 0;
    for (let c = 1; c <= ws.columnCount; c++) {
      const h = cellStr(header.getCell(c)).replace(/\s+/g, "");
      if (!skuCol && (/코드명|단품코드|^코드$|sku/i.test(h))) skuCol = c;
      if (!nameCol && (/상품명|품목명/.test(h))) nameCol = c;
      if (!wCol && (/총중량|주문당총중량/.test(h))) wCol = c;
    }
    if (!skuCol || !nameCol || !wCol) {
      return NextResponse.json({ ok: false, error: `열을 못 찾음(코드명·상품명·총중량 필요). 인식: sku=${skuCol} 상품명=${nameCol} 총중량=${wCol}` }, { status: 400 });
    }

    const map = new Map<string, { sku: string; courier_name: string; order_weight: number }>();
    for (let r = 2; r <= ws.rowCount; r++) {
      const sku = cellStr(ws.getRow(r).getCell(skuCol)).trim();
      if (!sku) continue;
      map.set(sku.toUpperCase(), {
        sku,
        courier_name: cellStr(ws.getRow(r).getCell(nameCol)).trim(),
        order_weight: Number(cellStr(ws.getRow(r).getCell(wCol))) || 0,
      });
    }
    const rows = [...map.values()].map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "유효한 코드 행이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { error } = await sb.from("shipping_codes").upsert(rows, { onConflict: "sku" });
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (053 적용 확인)` }, { status: 500 });
    return NextResponse.json({ ok: true, imported: rows.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "업로드 실패") }, { status: 500 });
  }
}
