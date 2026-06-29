import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeProduct, type Product, type ProductInput } from "@/app/lib/b2b-types";
import { PRODUCT_DIFF_FIELDS, displayValue, rowToInput } from "@/app/lib/b2b-product-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return "";
  }
  return String(v).trim();
}

const NUMERIC_KEYS = new Set<string>(["retail_price", "sale_price", "purchase_price", "cost_price", "volume_kg"]);

type Change = { label: string; from: string; to: string };
type Update = { id: string; name: string; changes: Change[]; row: ProductInput };
type Create = { name: string; row: ProductInput };

// POST /api/b2b/products/import (multipart: file) — 파싱·정규화 후 변경 미리보기. DB 변경 없음.
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

    // 헤더 → 열번호
    const headerRow = ws.getRow(1);
    const colByHeader = new Map<string, number>();
    headerRow.eachCell((cell, col) => colByHeader.set(cellStr(cell.value), col));
    if (!colByHeader.has("품목명")) {
      return NextResponse.json({ ok: false, error: "헤더에 '품목명' 이 없습니다. 추출한 양식 그대로 업로드하세요." }, { status: 400 });
    }

    // 기존 제품 맵(id 기준)
    const { data, error } = await supabaseAdmin().from("products").select("*");
    if (error) throw error;
    const existing = new Map<string, Product>();
    for (const p of (data ?? []) as Product[]) existing.set(p.id, p);

    const creates: Create[] = [];
    const updates: Update[] = [];
    const errors: { line: number; msg: string }[] = [];
    let unchanged = 0;

    const lastRow = ws.rowCount;
    for (let r = 2; r <= lastRow; r++) {
      const row = ws.getRow(r);
      const get = (h: string): string => {
        const col = colByHeader.get(h);
        return col ? cellStr(row.getCell(col).value) : "";
      };
      // 완전 빈 행 스킵
      if (!get("품목명") && !get("ID") && !get("SKU")) continue;

      const { id, input } = rowToInput(get);
      if (!input.name) { errors.push({ line: r, msg: "품목명이 비어 있습니다." }); continue; }
      const clean = normalizeProduct(input);

      if (!id) { creates.push({ name: clean.name, row: clean }); continue; }
      const prev = existing.get(id);
      if (!prev) { errors.push({ line: r, msg: `ID 를 찾을 수 없습니다(${id.slice(0, 8)}…). 신규면 ID 칸을 비우세요.` }); continue; }

      const changes: Change[] = [];
      for (const { key, label } of PRODUCT_DIFF_FIELDS) {
        const a = (prev as unknown as Record<string, unknown>)[key];
        const b = (clean as unknown as Record<string, unknown>)[key];
        let same: boolean;
        if (NUMERIC_KEYS.has(key)) same = (Number(a) || 0) === (Number(b) || 0); // null/undefined/"" → 0
        else if (key === "active") same = (a !== false) === (b !== false);
        else same = String(a ?? "").trim() === String(b ?? "").trim();
        if (!same) changes.push({ label, from: displayValue(key, a), to: displayValue(key, b) });
      }
      if (changes.length === 0) { unchanged++; continue; }
      updates.push({ id, name: clean.name, changes, row: { ...clean, id } });
    }

    return NextResponse.json({
      ok: true,
      summary: { creates: creates.length, updates: updates.length, unchanged, errors: errors.length },
      creates, updates, errors,
    });
  } catch (err) {
    console.error("[b2b/products import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
