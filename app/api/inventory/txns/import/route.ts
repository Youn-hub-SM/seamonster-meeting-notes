import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { signedQty } from "@/app/lib/inventory";
import { xlsxNum } from "@/app/lib/inventory-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return "";
  }
  return String(v).trim();
}

export type ImportTxn = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null };

// POST /api/inventory/txns/import (multipart: file) — 입출고 엑셀 파싱·검증. DB 변경 없음(미리보기).
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });
    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    const headerRow = ws.getRow(1);
    const col = new Map<string, number>();
    headerRow.eachCell((cell, c) => col.set(cellStr(cell.value), c));
    if (!col.has("유형") || !col.has("수량")) return NextResponse.json({ ok: false, error: "헤더에 '유형'·'수량'이 없습니다. 양식 그대로 업로드하세요." }, { status: 400 });

    // 품목 매칭표 (SKU·품목명 → id 목록; 중복 가능)
    const { data: products, error } = await supabaseAdmin().from("products").select("id, sku, name").eq("active", true);
    if (error) throw error;
    const bySku = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const nameOf = new Map<string, string>();
    for (const p of products ?? []) {
      nameOf.set(p.id, p.name);
      if (p.sku) { const k = String(p.sku).trim(); if (k) bySku.set(k, [...(bySku.get(k) || []), p.id]); }
      const nk = String(p.name).trim(); byName.set(nk, [...(byName.get(nk) || []), p.id]);
    }
    const resolve = (sku: string, name: string): { id?: string; err?: string } => {
      if (sku) { const ids = bySku.get(sku); if (ids?.length === 1) return { id: ids[0] }; if (ids && ids.length > 1) return { err: `SKU '${sku}' 가 ${ids.length}개 품목과 중복 — 품목명으로 구분하세요` }; }
      if (name) { const ids = byName.get(name); if (ids?.length === 1) return { id: ids[0] }; if (ids && ids.length > 1) return { err: `품목명 '${name}' 이 ${ids.length}개와 중복 — SKU 로 지정하세요` }; }
      return { err: `품목을 찾을 수 없음 (SKU '${sku || "-"}' / 명 '${name || "-"}')` };
    };

    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const rows: ImportTxn[] = [];
    const errors: { line: number; msg: string }[] = [];
    const last = ws.rowCount;
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const type = get("유형");
      const sku = get("SKU"); const name = get("품목명");
      if (!type && !sku && !name && !get("수량")) continue; // 빈 행
      if (type !== "입고" && type !== "출고") { errors.push({ line: r, msg: `유형은 '입고' 또는 '출고' (입력: '${type || "-"}')` }); continue; }
      const qtyMag = Math.abs(Math.round(xlsxNum(get("수량"))));
      if (qtyMag <= 0) { errors.push({ line: r, msg: "수량은 1 이상" }); continue; }
      const { id, err } = resolve(sku, name);
      if (!id) { errors.push({ line: r, msg: err || "품목 매칭 실패" }); continue; }
      const dateRaw = get("날짜"); const txn_date = DATE_RE.test(dateRaw) ? dateRaw : today;
      const amt = xlsxNum(get("단가"));
      rows.push({
        type, qty: signedQty(type, qtyMag), product_id: id, product_name: nameOf.get(id) || name,
        unit_amount: amt > 0 ? Math.round(amt) : null, txn_date, partner: get("거래처") || null, memo: get("메모") || null,
      });
    }
    return NextResponse.json({ ok: true, summary: { valid: rows.length, errors: errors.length }, rows, errors });
  } catch (err) {
    console.error("[inventory/txns import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
