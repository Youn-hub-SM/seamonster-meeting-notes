import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?q=&limit= — 상품마스터의 택배 정보(courier_name·courier_weight) 목록 + 개수.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") || "").trim();
    const limit = Math.min(3000, Math.max(1, Number(sp.get("limit")) || 800));
    const sb = supabaseAdmin();
    const { count } = await sb.from("products").select("*", { count: "exact", head: true }).neq("courier_name", "");
    let query = sb.from("products").select("sku, name, courier_name, courier_weight").order("sku").limit(limit);
    if (q) query = query.or(`sku.ilike.%${q.replace(/[%_]/g, " ")}%,courier_name.ilike.%${q.replace(/[%_]/g, " ")}%,name.ilike.%${q.replace(/[%_]/g, " ")}%`);
    else query = query.neq("courier_name", "");
    const { data, error } = await query;
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (054 적용 확인)` }, { status: 500 });
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

// POST (multipart: file) — 'code' 탭(코드명·상품명·주문당 총 중량) 업로드 →
//  상품마스터 매칭 SKU 는 택배정보 갱신, 없는 SKU 는 상품 신규 생성(택배 필드만·원가는 나중).
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

    const map = new Map<string, { sku: string; courier_name: string; courier_weight: number }>();
    for (let r = 2; r <= ws.rowCount; r++) {
      const sku = cellStr(ws.getRow(r).getCell(skuCol)).trim();
      if (!sku) continue;
      map.set(sku.toUpperCase(), { sku, courier_name: cellStr(ws.getRow(r).getCell(nameCol)).trim(), courier_weight: Number(cellStr(ws.getRow(r).getCell(wCol))) || 0 });
    }
    if (map.size === 0) return NextResponse.json({ ok: false, error: "유효한 코드 행이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    // 기존 상품 sku → id 목록
    const { data: prods, error: pErr } = await sb.from("products").select("id, sku");
    if (pErr) return NextResponse.json({ ok: false, error: `${pErr.message} (054 적용 확인)` }, { status: 500 });
    const bySku = new Map<string, string[]>();
    for (const p of prods ?? []) { const s = String(p.sku || "").trim().toUpperCase(); if (s) bySku.set(s, [...(bySku.get(s) || []), p.id]); }

    const updates: { id: string; courier_name: string; courier_weight: number }[] = [];
    const inserts: Record<string, unknown>[] = [];
    let updated = 0, created = 0;
    for (const c of map.values()) {
      const ids = bySku.get(c.sku.toUpperCase());
      if (ids?.length) { for (const id of ids) updates.push({ id, courier_name: c.courier_name, courier_weight: c.courier_weight }); updated++; }
      else { inserts.push({ sku: c.sku, name: c.courier_name || c.sku, unit: "개", tax_type: "taxable", active: true, courier_name: c.courier_name, courier_weight: c.courier_weight }); created++; }
    }
    // 기존 갱신(부분 컬럼 upsert) — id 존재하므로 UPDATE 로 동작
    for (let i = 0; i < updates.length; i += 500) {
      const { error } = await sb.from("products").upsert(updates.slice(i, i + 500), { onConflict: "id" });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (inserts.length) {
      const { error } = await sb.from("products").insert(inserts);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, updated, created });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "업로드 실패") }, { status: 500 });
  }
}
