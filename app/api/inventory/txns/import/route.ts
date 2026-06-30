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
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return "";
  }
  return String(v).trim();
}

export type ImportTxn = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null };

// POST /api/inventory/txns/import (multipart)
//  필드: file, type(입고|출고, 양식에 유형 컬럼 없을 때 적용), txn_date(선택), partner(선택)
//  양식: 'SKU | 수량 | 단가' (BoxHero Order Items). 유형/날짜/거래처/메모 컬럼이 있으면 행값이 우선.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });
    const formType = String(form.get("type") || "") as "입고" | "출고" | "";
    const formDateRaw = String(form.get("txn_date") || "");
    const formDate = DATE_RE.test(formDateRaw) ? formDateRaw : "";
    const formPartner = String(form.get("partner") || "").trim();

    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    const headerRow = ws.getRow(1);
    const col = new Map<string, number>();
    headerRow.eachCell((cell, c) => col.set(cellStr(cell.value), c));
    if (!col.has("SKU") || !col.has("수량")) return NextResponse.json({ ok: false, error: "헤더에 'SKU'·'수량' 이 필요합니다. (양식: SKU·수량·단가)" }, { status: 400 });
    const hasType = col.has("유형");
    if (!hasType && formType !== "입고" && formType !== "출고") {
      return NextResponse.json({ ok: false, error: "구매(입고) 또는 판매(출고)를 선택하고 업로드하세요." }, { status: 400 });
    }

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
      if (sku) { const ids = bySku.get(sku); if (ids?.length === 1) return { id: ids[0] }; if (ids && ids.length > 1) return { err: `SKU '${sku}' 가 ${ids.length}개 품목과 중복` }; }
      if (name) { const ids = byName.get(name); if (ids?.length === 1) return { id: ids[0] }; if (ids && ids.length > 1) return { err: `품목명 '${name}' 이 ${ids.length}개와 중복 — SKU 로 지정` }; }
      return { err: `품목을 찾을 수 없음 (SKU '${sku || "-"}')` };
    };

    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const rows: ImportTxn[] = [];
    const errors: { line: number; msg: string }[] = [];
    const last = ws.rowCount;
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const sku = get("SKU"); const name = get("품목명");
      const qtyCell = get("수량");
      if (!sku && !name && !qtyCell) continue; // 빈 행

      // 행에 유형이 있고 입고/출고면 우선, 아니면(예: BoxHero '제품') 업로드 시 선택값으로 폴백.
      const rowType = hasType ? get("유형") : "";
      const type = (rowType === "입고" || rowType === "출고" ? rowType : formType) as "입고" | "출고";
      if (type !== "입고" && type !== "출고") { errors.push({ line: r, msg: `유형이 올바르지 않음 ('${rowType || "-"}') — 구매/판매를 선택하세요` }); continue; }
      const qtyMag = Math.abs(Math.round(xlsxNum(qtyCell)));
      if (qtyMag <= 0) { errors.push({ line: r, msg: "수량은 1 이상" }); continue; }
      const { id, err } = resolve(sku, name);
      if (!id) { errors.push({ line: r, msg: err || "품목 매칭 실패" }); continue; }
      // 행별 날짜(과거 출고 일괄 이관용). 컬럼명 별칭 + "2026-05-08 17:27" 같은 시각 포함도 앞 10자 추출.
      const dateRaw = get("날짜") || get("일자") || get("거래일") || get("발주일");
      const dm = dateRaw.match(/^\d{4}-\d{2}-\d{2}/);
      const txn_date = dm ? dm[0] : (formDate || today);
      const amt = xlsxNum(get("단가"));
      rows.push({
        type, qty: signedQty(type, qtyMag), product_id: id, product_name: nameOf.get(id) || name,
        unit_amount: amt > 0 ? Math.round(amt) : null, txn_date,
        partner: (get("거래처") || formPartner) || null, memo: get("메모") || null,
      });
    }
    return NextResponse.json({ ok: true, summary: { valid: rows.length, errors: errors.length }, rows, errors });
  } catch (err) {
    console.error("[inventory/txns import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
