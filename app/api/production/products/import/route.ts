import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/production/products/import  (multipart: file)
// 박스히어로 items 내보내기 엑셀을 파싱 → SKU 기준으로 기존 products 와 비교한 미리보기 반환.
//  금액(구매가·판매가)은 가져오지 않음 — 품목 식별(SKU·제품명·옵션)만.

export interface ImportRow {
  sku: string;
  name: string;
  spec: string | null;
}

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    // exceljs rich text / hyperlink / formula 결과 방어
    const o = v as { text?: string; result?: unknown };
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return "";
  }
  return String(v).trim();
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });
    }

    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    // 헤더에서 컬럼 위치 찾기 (SKU / 제품명 / 옵션). 박스히어로 export 기준.
    const headerVals = ws.getRow(1).values as unknown[];
    const colOf = (...names: string[]) => {
      for (let i = 1; i < headerVals.length; i++) {
        const h = cellStr(headerVals[i]);
        if (names.includes(h)) return i;
      }
      return -1;
    };
    const cSku = colOf("SKU", "sku");
    const cName = colOf("제품명", "품목명", "상품명", "이름");
    const cSpec = colOf("옵션", "규격");
    if (cSku < 0 || cName < 0) {
      return NextResponse.json(
        { ok: false, error: "필수 컬럼(SKU, 제품명)을 찾을 수 없습니다. 박스히어로 품목 내보내기 파일인지 확인하세요." },
        { status: 400 }
      );
    }

    const rows: ImportRow[] = [];
    const seen = new Set<string>();
    let skippedNoSku = 0;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const vals = row.values as unknown[];
      const sku = cellStr(vals[cSku]);
      const name = cellStr(vals[cName]);
      if (!sku) { if (name) skippedNoSku++; return; }
      const key = sku.toUpperCase();
      if (seen.has(key)) return; // 파일 내 중복 SKU 1개만
      seen.add(key);
      const spec = cSpec > 0 ? cellStr(vals[cSpec]) : "";
      rows.push({ sku, name, spec: spec || null });
    });

    // 기존 products 와 비교
    const sb = supabaseAdmin();
    const { data: products, error } = await sb.from("products").select("id, sku, name, spec");
    if (error) throw error;
    const bySku = new Map<string, { id: string; name: string; spec: string | null }>();
    for (const p of products ?? []) {
      if (p.sku) bySku.set(String(p.sku).toUpperCase(), { id: p.id, name: p.name, spec: p.spec });
    }

    const toAdd: ImportRow[] = [];
    const toUpdate: (ImportRow & { oldName: string; oldSpec: string | null })[] = [];
    let unchanged = 0;
    for (const r of rows) {
      const ex = bySku.get(r.sku.toUpperCase());
      if (!ex) { toAdd.push(r); continue; }
      const nameChanged = (ex.name || "") !== (r.name || "");
      const specChanged = (ex.spec || "") !== (r.spec || "");
      if (nameChanged || specChanged) toUpdate.push({ ...r, oldName: ex.name, oldSpec: ex.spec });
      else unchanged++;
    }

    return NextResponse.json({
      ok: true,
      total: rows.length,
      skippedNoSku,
      unchanged,
      toAdd,
      toUpdate,
    });
  } catch (err) {
    console.error("[production/products/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "엑셀 파싱 실패") }, { status: 500 });
  }
}
