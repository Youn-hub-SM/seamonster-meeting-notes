import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { cellStr, xlsxNum } from "@/app/lib/inventory-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type BundleComp = { sku: string; qty: number; name: string | null; ok: boolean; err?: string };
export type BundlePreview = { parentSku: string; name: string; parentExists: boolean; components: BundleComp[]; ok: boolean; err?: string };

// POST /api/inventory/bundles/import (multipart) — 묶음 엑셀 분석 → 미리보기.
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
    if (!col.has("묶음SKU") || !col.has("구성품SKU") || !col.has("수량"))
      return NextResponse.json({ ok: false, error: "헤더에 '묶음SKU'·'구성품SKU'·'수량' 이 필요합니다. (양식을 받아 사용하세요)" }, { status: 400 });

    // 비활성 포함 전체 조회 — apply 와 같은 기준(SKU 유일 073). 미사용 상품이 SKU 를 쥐고 있으면
    //  미리보기에서 미리 알려 '미리보기 OK → 반영 실패' 불일치를 없앤다.
    const { data: products, error } = await supabaseAdmin().from("products").select("id, sku, name, active");
    if (error) throw error;
    const bySku = new Map<string, { id: string; name: string; active: boolean }[]>();
    for (const p of products ?? []) { const k = p.sku ? String(p.sku).trim() : ""; if (k) bySku.set(k, [...(bySku.get(k) || []), { id: p.id, name: p.name, active: p.active !== false }]); }

    // 묶음SKU 로 그룹핑
    const groups = new Map<string, { name: string; comps: { sku: string; qty: number }[] }>();
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const parentSku = get("묶음SKU").trim();
      const compSku = get("구성품SKU").trim();
      const qtyRaw = get("수량");
      if (!parentSku && !compSku && !qtyRaw) continue;
      if (!parentSku || !compSku) continue; // 불완전 행 스킵
      const g = groups.get(parentSku) || { name: "", comps: [] };
      if (!g.name && get("묶음명").trim()) g.name = get("묶음명").trim();
      g.comps.push({ sku: compSku, qty: Math.max(1, Math.round(xlsxNum(qtyRaw) || 1)) });
      groups.set(parentSku, g);
    }

    const previews: BundlePreview[] = [];
    for (const [parentSku, g] of groups) {
      const pIds = bySku.get(parentSku);
      const parentExists = !!pIds && pIds.length === 1;
      let err: string | undefined;
      if (pIds && pIds.length > 1) err = `묶음SKU '${parentSku}' 가 ${pIds.length}개 상품과 중복`;
      else if (pIds && pIds.length === 1 && !pIds[0].active) err = `묶음SKU '${parentSku}' 는 미사용 상품 — 사용 처리 후 반영하세요`;
      const components: BundleComp[] = g.comps.map((c) => {
        const ids = bySku.get(c.sku);
        if (!ids || ids.length === 0) return { sku: c.sku, qty: c.qty, name: null, ok: false, err: "구성품 SKU 없음" };
        if (ids.length > 1) return { sku: c.sku, qty: c.qty, name: ids[0].name, ok: false, err: `${ids.length}개와 중복` };
        if (!ids[0].active) return { sku: c.sku, qty: c.qty, name: ids[0].name, ok: false, err: "미사용 상품" };
        return { sku: c.sku, qty: c.qty, name: ids[0].name, ok: true };
      });
      const ok = !err && components.length > 0 && components.every((c) => c.ok);
      previews.push({ parentSku, name: g.name || parentSku, parentExists, components, ok, err });
    }

    const summary = {
      bundles: previews.length,
      valid: previews.filter((p) => p.ok).length,
      willCreate: previews.filter((p) => p.ok && !p.parentExists).length,
      errors: previews.filter((p) => !p.ok).length,
    };
    return NextResponse.json({ ok: true, summary, previews });
  } catch (err) {
    console.error("[bundles/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
