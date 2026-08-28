import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { signedQty } from "@/app/lib/inventory";
import { xlsxNum } from "@/app/lib/inventory-xlsx";
import { getAllBundles, expandBundleQty, isBundleId, type BundleComponent } from "@/app/lib/product-bundles";

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

export type ImportTxn = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null; reason?: string | null };

// 같은 유형·품목·거래일의 중복 행을 합산(수량 합, 단가는 수량가중평균). 반환 [병합결과, 합쳐진 행수].
function mergeRows(rows: ImportTxn[]): [ImportTxn[], number] {
  const m = new Map<string, ImportTxn>();
  for (const r of rows) {
    const key = `${r.type}\u0000${r.product_id}\u0000${r.txn_date}`;
    const cur = m.get(key);
    if (!cur) { m.set(key, { ...r }); continue; }
    const prevQ = Math.abs(cur.qty), addQ = Math.abs(r.qty), totQ = prevQ + addQ;
    if (cur.unit_amount != null || r.unit_amount != null) {
      cur.unit_amount = totQ > 0 ? Math.round(((cur.unit_amount ?? 0) * prevQ + (r.unit_amount ?? 0) * addQ) / totQ) : cur.unit_amount;
    }
    cur.qty += r.qty; // 같은 유형 → 부호 동일, 합산
  }
  const out = [...m.values()];
  return [out, rows.length - out.length];
}

// 묶음(세트) 행을 구성품 행으로 분해(중첩 세트까지 재귀 — expandBundleQty 공용 규칙).
//  세트 단가는 구성품에 배분 불가 → unit_amount 비움. 미리보기와 실제 기록이 같은 규칙을 써야 어긋나지 않는다.
function expandBundles(rows: ImportTxn[], bundles: Map<string, BundleComponent[]>, nameOf: Map<string, string>): ImportTxn[] {
  if (!bundles.size) return rows;
  const out: ImportTxn[] = [];
  for (const r of rows) {
    if (!isBundleId(bundles, r.product_id)) { out.push(r); continue; }
    const per = expandBundleQty(bundles, r.product_id, Math.abs(r.qty)); // 세트 수량(부호는 유형이 결정)
    for (const [pid, q] of per) {
      out.push({
        type: r.type, qty: signedQty(r.type, q),
        product_id: pid, product_name: nameOf.get(pid) || "",
        unit_amount: null, txn_date: r.txn_date, partner: r.partner,
        memo: r.memo ? `${r.memo} (세트 분해)` : "세트 분해",
      });
    }
  }
  return out;
}

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
    const hasSkuHeader = col.has("SKU") && col.has("수량");

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

    const bundles = await getAllBundles(supabaseAdmin()); // 세트 SKU → 구성품 분해용(037 미적용이면 빈 맵)
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    // ── 출고 위치기반 양식(수량 | (무시) | SKU) — 헤더로 SKU·수량을 못 찾으면 폴백 ──
    //  1열=수량, 3열=SKU, 2열은 무시. 헤더/합계 행(수량 비숫자)은 자동 스킵. 단가 없음, 거래일은 업로드 지정값.
    if (!hasSkuHeader) {
      if (formType !== "출고") {
        return NextResponse.json({ ok: false, error: "헤더에 'SKU'·'수량' 이 필요합니다. (입고 양식: SKU·수량·단가 / 출고 양식: 수량·(무시)·SKU)" }, { status: 400 });
      }
      const outRows: ImportTxn[] = [];
      const outErrors: { line: number; msg: string }[] = [];
      const lastOut = ws.rowCount;
      for (let r = 1; r <= lastOut; r++) {
        const row = ws.getRow(r);
        const qtyRaw = cellStr(row.getCell(1).value); // 1열 = 수량
        const skuRaw = cellStr(row.getCell(3).value); // 3열 = SKU (2열 무시)
        if (!qtyRaw && !skuRaw) continue;
        const qtyMag = Math.abs(Math.round(xlsxNum(qtyRaw) * 100) / 100);
        if (qtyMag <= 0) { if (r === 1 || !skuRaw) continue; outErrors.push({ line: r, msg: "수량(1열)은 1 이상" }); continue; } // 헤더/합계 행 스킵
        if (!skuRaw) { outErrors.push({ line: r, msg: "SKU(3열)가 비었습니다" }); continue; }
        const { id, err } = resolve(skuRaw, "");
        if (!id) { outErrors.push({ line: r, msg: err || "품목 매칭 실패" }); continue; }
        outRows.push({ type: "출고", qty: signedQty("출고", qtyMag), product_id: id, product_name: nameOf.get(id) || "", unit_amount: null, txn_date: formDate || today, partner: formPartner || null, memo: null });
      }
      const [mOut, mergedOut] = mergeRows(expandBundles(outRows, bundles, nameOf));
      return NextResponse.json({ ok: true, summary: { valid: mOut.length, errors: outErrors.length, merged: mergedOut }, rows: mOut, errors: outErrors });
    }

    // 전 품목이 채워져 내려간 양식인지 판별 — 그 양식은 안 적은 줄이 대부분이라 오류가 아니라 '건너뜀'이 맞다.
    //  손으로 만든 파일이면 적어 넣은 행만 있는 것이므로 수량 누락은 실수 → 오류로 알린다.
    const isFilledForm = col.has("품목명") && [...col.keys()].some((h) => h.startsWith("현재고"));
    const hasType = col.has("유형");
    if (!hasType && formType !== "입고" && formType !== "출고") {
      return NextResponse.json({ ok: false, error: "구매(입고) 또는 판매(출고)를 선택하고 업로드하세요." }, { status: 400 });
    }

    const rows: ImportTxn[] = [];
    const errors: { line: number; msg: string }[] = [];
    let skipped = 0; // 수량 미입력 행 — 전 품목이 채워진 양식을 그대로 올리는 게 정상 사용이라 오류로 보지 않는다
    const last = ws.rowCount;
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => { const c = col.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      const sku = get("SKU"); const name = get("품목명");
      const qtyCell = get("수량");
      if (!sku && !name && !qtyCell) continue; // 빈 행
      if (qtyCell.trim() === "") { // 품목만 있고 수량을 안 적은 행
        if (isFilledForm) { skipped++; continue; }
        errors.push({ line: r, msg: "수량이 비었습니다." }); continue;
      }

      // 행에 유형이 있고 입고/출고면 우선, 아니면(예: BoxHero '제품') 업로드 시 선택값으로 폴백.
      const rowType = hasType ? get("유형") : "";
      const type = (rowType === "입고" || rowType === "출고" ? rowType : formType) as "입고" | "출고";
      if (type !== "입고" && type !== "출고") { errors.push({ line: r, msg: `유형이 올바르지 않음 ('${rowType || "-"}') — 구매/판매를 선택하세요` }); continue; }
      const qtyMag = Math.abs(Math.round(xlsxNum(qtyCell) * 100) / 100);
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
    const [merged, mergedCount] = mergeRows(expandBundles(rows, bundles, nameOf));
    return NextResponse.json({ ok: true, summary: { valid: merged.length, errors: errors.length, merged: mergedCount, skipped }, rows: merged, errors });
  } catch (err) {
    console.error("[inventory/txns import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
