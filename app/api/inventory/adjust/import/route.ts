import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { cellStr, xlsxNum } from "@/app/lib/inventory-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type AdjustRow = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; current: number; target: number; delta: number; memo: string | null };

// POST /api/inventory/adjust/import (multipart) — 실사 엑셀 파싱 → 델타 미리보기.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });
    const chan = form.get("channel") === "도매" ? "도매" : "소매"; // 실사 대상 채널(036, 기본 소매)

    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    const headerRow = ws.getRow(1);
    const col = new Map<string, number>();
    headerRow.eachCell((cell, c) => col.set(cellStr(cell.value), c));
    if (!col.has("SKU") || !col.has("실사수량")) return NextResponse.json({ ok: false, error: "헤더에 'SKU'·'실사수량'이 필요합니다. (양식을 받아 사용하세요)" }, { status: 400 });

    const sb = supabaseAdmin();
    const stockRpc = async () => {
      const res = await sb.rpc("inventory_stock", { asof: null, chan });
      if (!res.error) return res;
      return sb.rpc("inventory_stock", { asof: null }); // 036 미적용 폴백(전체)
    };
    const [pr, tr] = await Promise.all([
      sb.from("products").select("id, sku, name, spec, unit").eq("active", true),
      stockRpc(),
    ]);
    if (pr.error) throw pr.error;
    if (tr.error) throw tr.error;
    const bySku = new Map<string, { id: string; name: string; spec: string | null; unit: string }[]>();
    for (const p of pr.data ?? []) { const k = p.sku ? String(p.sku).trim() : ""; if (k) bySku.set(k, [...(bySku.get(k) || []), { id: p.id, name: p.name, spec: p.spec, unit: p.unit }]); }
    const stock = new Map<string, number>();
    for (const t of (tr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);

    const rows: AdjustRow[] = [];
    const errors: { line: number; msg: string }[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const sku = get("SKU").trim();
      const targetRaw = get("실사수량");
      if (!sku && !targetRaw) continue;
      if (!sku) { errors.push({ line: r, msg: "SKU가 비었습니다." }); continue; }
      const ids = bySku.get(sku);
      if (!ids || ids.length === 0) { errors.push({ line: r, msg: `SKU '${sku}' 품목을 찾을 수 없음` }); continue; }
      if (ids.length > 1) { errors.push({ line: r, msg: `SKU '${sku}' 가 ${ids.length}개 품목과 중복` }); continue; }
      if (targetRaw.trim() === "") { errors.push({ line: r, msg: "실사수량이 비었습니다." }); continue; }
      const target = Math.round(xlsxNum(targetRaw) * 100) / 100;
      if (target < 0) { errors.push({ line: r, msg: "실사수량은 0 이상" }); continue; }
      const p = ids[0];
      const current = stock.get(p.id) || 0;
      rows.push({ product_id: p.id, sku, name: p.name, spec: p.spec, unit: p.unit, current, target, delta: target - current, memo: get("메모").trim() || null });
    }
    const changed = rows.filter((r) => r.delta !== 0).length;
    return NextResponse.json({ ok: true, channel: chan, summary: { valid: rows.length, changed, errors: errors.length }, rows, errors });
  } catch (err) {
    console.error("[inventory/adjust/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
