import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { loadRequests } from "@/app/lib/wholesale-production-db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/production/requests/[id]/sheet — 생산 요청 한 건을 제조사 전달용 엑셀(편집·인쇄)로.
//  텍스트 복사([요청서])와 같은 원칙: 내부 정보(요청자·담당·제목·용도)는 뺀다(대표 확정).
//  표(상품명·수량·단위·비고·작업완료) + 하단 품목·중량별 총중량 + 확인 서명란. A4 세로 인쇄 맞춤.
type Ctx = { params: Promise<{ id: string }> };

// 단위당 중량 판정 — 기준은 상품마스터 '속성'(대표 확정, 2026-08-21):
//  · 속성에 '벌크'가 있으면 벌크 포장 — 규격/이름의 곱셈형("5x2"=5kg×2, "1kg x 2")을 읽고,
//    표기가 없으면 벌크 기본 5kg×2(=10kg). 이름에 조각 중량(140g·200g)이 있어도 무시한다.
//  · 벌크가 아니면 표기 중량 그대로 — 단위 명시 곱셈형("500g×2") 또는 단일 토큰("200g"·"1.5kg").
function parseWeight(isBulk: boolean, ...sources: (string | null | undefined)[]): { grams: number | null; label: string } {
  for (const src of sources) {
    if (!src) continue;
    const withUnit = src.match(/(\d+(?:\.\d+)?)\s*(kg|g)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
    if (withUnit) {
      const v = parseFloat(withUnit[1]) * (withUnit[2].toLowerCase() === "kg" ? 1000 : 1);
      const n = parseFloat(withUnit[3]);
      if (v > 0 && n > 0) return { grams: v * n, label: `${unitLabel(v)}×${n}` };
    }
    if (isBulk) {
      const bare = src.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
      if (bare) {
        const kg = parseFloat(bare[1]);
        const n = parseFloat(bare[2]);
        if (kg > 0 && n > 0) return { grams: kg * 1000 * n, label: `${unitLabel(kg * 1000)}×${n}` };
      }
    }
  }
  if (isBulk) return { grams: 10000, label: "5kg×2" }; // 벌크 기본 포장
  for (const src of sources) {
    if (!src) continue;
    const ms = [...src.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g)/gi)];
    if (ms.length) {
      const m = ms[ms.length - 1];
      const v = parseFloat(m[1]) * (m[2].toLowerCase() === "kg" ? 1000 : 1);
      if (v > 0) return { grams: v, label: unitLabel(v) };
    }
  }
  return { grams: null, label: "-" };
}
const unitLabel = (g: number) => (g >= 1000 ? `${+(g / 1000).toFixed(2)}kg` : `${+g.toFixed(0)}g`);

const THIN = { style: "thin" as const, color: { argb: "FFBBBBBB" } };
const BOX = { top: THIN, bottom: THIN, left: THIN, right: THIN };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const [r] = await loadRequests(supabaseAdmin(), { id });
    if (!r) return NextResponse.json({ ok: false, error: "요청서를 찾을 수 없습니다." }, { status: 404 });

    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("생산요청서", {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
    });
    ws.columns = [{ width: 32 }, { width: 10 }, { width: 8 }, { width: 30 }, { width: 10 }];

    const title = ws.addRow(["생산 요청서"]);
    title.font = { bold: true, size: 18 };
    title.height = 28;
    ws.mergeCells(title.number, 1, title.number, 5);
    title.getCell(1).alignment = { horizontal: "center", vertical: "middle" };

    const meta1 = ws.addRow([`요청번호  ${r.req_no || "-"}`, "", "", `요청일  ${r.request_date}`, ""]);
    ws.mergeCells(meta1.number, 1, meta1.number, 3);
    ws.mergeCells(meta1.number, 4, meta1.number, 5);
    const meta2 = ws.addRow([`생산마감일  ${r.due_date || "-"}`, "", "", `발행일  ${today}`, ""]);
    ws.mergeCells(meta2.number, 1, meta2.number, 3);
    ws.mergeCells(meta2.number, 4, meta2.number, 5);
    meta2.getCell(1).font = { bold: true };
    ws.addRow([]);

    // ── 품목 표 — 비고는 제조사 참고 멘트 칸(요청 메모를 미리 채워두고 엑셀에서 수정), 작업완료는 수기 체크 칸 ──
    const header = ws.addRow(["상품명", "수량", "단위", "비고(제조사 참고)", "작업완료"]);
    header.font = { bold: true };
    header.height = 20;
    header.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      c.border = BOX;
      c.alignment = { horizontal: "center", vertical: "middle" };
    });
    for (const it of r.items) {
      const nameCell = it.spec && !it.name.includes(it.spec) ? `${it.name} ${it.spec}` : it.name;
      const row = ws.addRow([nameCell, it.requested_qty, it.unit || "개", it.memo || "", ""]);
      row.height = 22; // 수기 메모·체크 여유
      row.getCell(2).numFmt = "#,##0";
      row.eachCell({ includeEmpty: true }, (c, col) => {
        c.border = BOX;
        c.alignment = { vertical: "middle", horizontal: col === 1 || col === 4 ? "left" : "center" };
      });
      // includeEmpty 로도 마지막 열이 비면 스킵될 수 있어 명시적으로 테두리를 채운다
      for (let col = 1; col <= 5; col++) row.getCell(col).border = BOX;
    }
    const totalQty = r.items.reduce((s, it) => s + (Number(it.requested_qty) || 0), 0);
    const tRow = ws.addRow(["합계", totalQty, "", "", ""]);
    tRow.font = { bold: true };
    tRow.getCell(2).numFmt = "#,##0";
    for (let col = 1; col <= 5; col++) tRow.getCell(col).border = BOX;

    // ── 옵션중량별 총중량 — 제조사가 원료 준비량을 바로 가늠하도록.
    //  묶음 기준(대표 확정, 2026-08-21): 벌크(속성)는 별도 줄, 나머지는 품목 구분 없이 옵션중량으로 묶는다. ──
    ws.addRow([]);
    const wTitle = ws.addRow(["옵션중량별 총중량 (벌크 별도)"]);
    wTitle.font = { bold: true, size: 12 };
    ws.mergeCells(wTitle.number, 1, wTitle.number, 5);

    // 품목 속성 조회 — '벌크' 판정. 조회 실패는 비벌크로 폴백(등록 자체는 계속).
    const ids = [...new Set(r.items.map((it) => it.product_id).filter(Boolean))];
    const attrsMap = new Map<string, string>();
    if (ids.length) {
      try {
        const { data } = await supabaseAdmin().from("products").select("id, attrs").in("id", ids);
        for (const p of (data || []) as { id: string; attrs: string | null }[]) attrsMap.set(String(p.id), String(p.attrs || ""));
      } catch { /* attrs 미적용 환경 등 — 비벌크 취급 */ }
    }

    const groups = new Map<string, { kind: "옵션" | "벌크"; grams: number | null; wLabel: string; qty: number }>();
    for (const it of r.items) {
      const isBulk = (attrsMap.get(String(it.product_id)) || "").includes("벌크");
      const { grams, label: wLabel } = parseWeight(isBulk, it.spec, it.name);
      const kind = isBulk ? "벌크" as const : "옵션" as const;
      const key = `${kind}|${wLabel}`;
      const g = groups.get(key) || { kind, grams, wLabel, qty: 0 };
      g.qty += Number(it.requested_qty) || 0;
      groups.set(key, g);
    }
    const wHeader = ws.addRow(["구분", "옵션중량", "수량", "총중량(kg)", ""]);
    wHeader.font = { bold: true };
    wHeader.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }; c.alignment = { horizontal: "center" }; });
    for (let col = 1; col <= 4; col++) wHeader.getCell(col).border = BOX;

    let sumKg = 0, sumQty = 0, unknown = 0;
    // 옵션(중량 오름차순, 미인식 뒤) 먼저, 벌크는 그 아래 별도
    const sorted = [...groups.values()].sort((a, b) =>
      (a.kind === "벌크" ? 1 : 0) - (b.kind === "벌크" ? 1 : 0) || (a.grams ?? Infinity) - (b.grams ?? Infinity));
    for (const g of sorted) {
      const kg = g.grams == null ? null : (g.grams * g.qty) / 1000;
      if (kg == null) unknown++; else sumKg += kg;
      sumQty += g.qty;
      const row = ws.addRow([g.kind, g.wLabel, g.qty, kg == null ? "-" : +kg.toFixed(1), ""]);
      row.getCell(3).numFmt = "#,##0";
      if (kg != null) row.getCell(4).numFmt = "#,##0.0";
      for (let col = 1; col <= 4; col++) { row.getCell(col).border = BOX; if (col > 1) row.getCell(col).alignment = { horizontal: "center" }; }
    }
    const wTotal = ws.addRow(["합계", "", sumQty, +sumKg.toFixed(1), ""]);
    wTotal.font = { bold: true };
    wTotal.getCell(3).numFmt = "#,##0";
    wTotal.getCell(4).numFmt = "#,##0.0";
    for (let col = 1; col <= 4; col++) { wTotal.getCell(col).border = BOX; if (col > 1) wTotal.getCell(col).alignment = { horizontal: "center" }; }
    if (unknown) {
      const note = ws.addRow([`* 중량을 인식하지 못한 품목 ${unknown}건은 총중량 합계에서 빠져 있습니다.`]);
      note.font = { size: 9, color: { argb: "FF888888" } };
      ws.mergeCells(note.number, 1, note.number, 5);
    }

    // ── 확인 서명란 ──
    ws.addRow([]);
    ws.addRow([]);
    const sign = ws.addRow(["발주자 확인:  ____________________", "", "", "제조사 확인:  ____________________", ""]);
    ws.mergeCells(sign.number, 1, sign.number, 3);
    ws.mergeCells(sign.number, 4, sign.number, 5);
    sign.height = 24;

    const buf = await wb.xlsx.writeBuffer();
    const label = (r.req_no || r.id.slice(0, 8)).replace(/[^\w-]/g, "");
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="production-request-${label}.xlsx"; filename*=UTF-8''${encodeURIComponent(`생산요청서_${r.req_no || r.request_date}.xlsx`)}`,
      },
    });
  } catch (err) {
    console.error("[production/requests/sheet]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서 생성 실패") }, { status: 500 });
  }
}
