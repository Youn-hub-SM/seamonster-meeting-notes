import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { xlsxNum, cellStr } from "@/app/lib/inventory-xlsx";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type ImportReturn = { product_id: string; name: string; sku: string | null; qty: number; unit_amount: number | null; memo: string | null };

// 같은 품목이 여러 줄이면 합산(단가는 수량가중평균) — 미리보기와 실제 저장이 같은 규칙이어야 한다.
function mergeRows(rows: ImportReturn[]): [ImportReturn[], number] {
  const m = new Map<string, ImportReturn>();
  for (const r of rows) {
    const cur = m.get(r.product_id);
    if (!cur) { m.set(r.product_id, { ...r }); continue; }
    const totQ = cur.qty + r.qty;
    if (cur.unit_amount != null || r.unit_amount != null) {
      cur.unit_amount = totQ > 0
        ? Math.round(((cur.unit_amount ?? 0) * cur.qty + (r.unit_amount ?? 0) * r.qty) / totQ)
        : cur.unit_amount;
    }
    cur.qty = totQ;
    if (r.memo && !cur.memo) cur.memo = r.memo;
  }
  const out = [...m.values()];
  return [out, rows.length - out.length];
}

// POST /api/inventory/returns/import (multipart: file)
//  양식: SKU | 품목명 | 매입수량(참고) | 반품수량 | 단가 | 메모.  '수량' 이라고만 적힌 열도 받는다.
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

    const col = new Map<string, number>();
    ws.getRow(1).eachCell((cell, c) => col.set(cellStr(cell.value), c));
    const qtyCol = col.get("반품수량") ?? col.get("수량");
    if (!col.has("SKU") || !qtyCol) {
      return NextResponse.json({ ok: false, error: "헤더에 'SKU' 와 '반품수량' 이 필요합니다. 양식을 다운로드해 쓰세요." }, { status: 400 });
    }

    const sb = supabaseAdmin();
    const [{ data: products, error }, bundles] = await Promise.all([
      sb.from("products").select("id, sku, name, spec").eq("active", true).limit(5000), // 직접입력 목록과 같은 한도
      getAllBundles(sb),
    ]);
    if (error) throw error;
    const bySku = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const label = new Map<string, { name: string; sku: string | null }>();
    for (const p of products ?? []) {
      if (isBundleId(bundles, p.id)) continue; // 번들(세트)은 자체 매입이 없다 — 반품 매칭 대상 아님
      const nm = p.spec ? `${p.name} ${p.spec}` : p.name;
      label.set(p.id, { name: nm, sku: p.sku ?? null });
      if (p.sku) { const k = String(p.sku).trim(); if (k) bySku.set(k, [...(bySku.get(k) || []), p.id]); }
      const nk = String(p.name).trim(); byName.set(nk, [...(byName.get(nk) || []), p.id]);
    }
    const resolve = (sku: string, name: string): { id?: string; err?: string } => {
      if (sku) { const ids = bySku.get(sku); if (ids?.length === 1) return { id: ids[0] }; if (ids && ids.length > 1) return { err: `SKU '${sku}' 가 ${ids.length}개 품목과 중복` }; }
      if (name) { const ids = byName.get(name); if (ids?.length === 1) return { id: ids[0] }; if (ids && ids.length > 1) return { err: `품목명 '${name}' 이 ${ids.length}개와 중복 — SKU 로 지정` }; }
      return { err: `품목을 찾을 수 없음 (SKU '${sku || "-"}')` };
    };

    const rows: ImportReturn[] = [];
    const errors: { line: number; msg: string }[] = [];
    let skipped = 0; // 반품수량을 안 적은 줄 — 채워 내려간 양식을 그대로 올리는 게 정상 사용이라 오류가 아니다
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const sku = get("SKU");
      const name = get("품목명");
      const qtyCell = cellStr(row.getCell(qtyCol).value);
      if (!sku && !name && !qtyCell) continue;              // 빈 행
      if (sku.startsWith("※")) continue;                    // 양식 맨 아래 안내 줄
      if (qtyCell.trim() === "") { skipped++; continue; }

      const qty = Math.abs(Math.round(xlsxNum(qtyCell) * 100) / 100);
      if (!(qty > 0)) { errors.push({ line: r, msg: "반품수량은 0보다 커야 합니다" }); continue; }
      const { id, err } = resolve(sku, name);
      if (!id) { errors.push({ line: r, msg: err || "품목 매칭 실패" }); continue; }
      const unit = Math.round(xlsxNum(get("단가")));
      const l = label.get(id);
      rows.push({
        product_id: id, name: l?.name || name, sku: l?.sku ?? (sku || null),
        qty, unit_amount: unit > 0 ? unit : null, memo: get("메모") || null,
      });
    }

    const [merged, mergedCount] = mergeRows(rows);
    return NextResponse.json({
      ok: true,
      summary: { valid: merged.length, errors: errors.length, skipped, merged: mergedCount },
      rows: merged, errors,
    });
  } catch (err) {
    console.error("[inventory/returns/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "분석 실패") }, { status: 500 });
  }
}
