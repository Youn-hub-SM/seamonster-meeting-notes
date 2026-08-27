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

// 소포장 단위 판정 — 총중량 표를 '단위중량 × 팩 수'로 집계하기 위한 분해(대표 확정, 2026-08-25).
//  같은 소포장이면 낱개 상품과 묶음 상품을 한 줄로 합쳐야 제조사가 몇 팩을 만들지 바로 안다.
//   예) 삼치순살 100g ×900 + 삼치순살 1kg(100g*10) ×150 → 100g 팩 2400개 = 240kg (한 줄)
//  규칙(우선순위) — 표기된 값만 쓰고 없는 값은 지어내지 않는다:
//   1. 옵션중량이 있는 경우 = 곱셈형 "100g*10"·"500g×2" → 옵션중량 100g × 팩 10개.
//      이름에 총량(1kg)이 함께 있어도 곱셈형(소포장)이 이긴다.
//   2. 속성이 '벌크'면 규격/이름의 "5x2"(단위 없는 곱셈)를 kg 로 읽어 5kg 팩 2개.
//   3. 옵션중량이 없는 경우 = 단일 토큰("200g"·"1.5kg") → 그 포장중량 × 요청수량(팩 1개).
//   4. 아무 표기도 없으면 계산하지 않는다(합계에서 빼고 각주로 알린다) — 추정값은 넣지 않는다.
type UnitSpec = { grams: number | null; packs: number; label: string };
function parseUnit(isBulk: boolean, ...sources: (string | null | undefined)[]): UnitSpec {
  // 1) 단위 명시 곱셈형 — 묶음 상품의 실제 소포장. "1kg(100g*10)"에서 100g×10 을 집는다.
  for (const src of sources) {
    if (!src) continue;
    const m = src.match(/(\d+(?:\.\d+)?)\s*(kg|g)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
    if (m) {
      const v = parseFloat(m[1]) * (m[2].toLowerCase() === "kg" ? 1000 : 1);
      const n = parseFloat(m[3]);
      if (v > 0 && n > 0) return { grams: v, packs: n, label: unitLabel(v) };
    }
  }
  // 2) 벌크 — 단위 없는 곱셈("5x2")은 kg 관례
  if (isBulk) {
    for (const src of sources) {
      if (!src) continue;
      const b = src.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
      if (b) {
        const kg = parseFloat(b[1]);
        const n = parseFloat(b[2]);
        if (kg > 0 && n > 0) return { grams: kg * 1000, packs: n, label: unitLabel(kg * 1000) };
      }
    }
    // 벌크인데 포장 표기가 없으면 아래 단일 토큰 규칙으로 내려간다(그것도 없으면 계산 불가).
  }
  // 3) 단일 중량 토큰 — 옵션중량이 없는 상품의 포장중량
  for (const src of sources) {
    if (!src) continue;
    const ms = [...src.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g)(?!\s*[x×*])/gi)];
    if (ms.length) {
      const m = ms[ms.length - 1];
      const v = parseFloat(m[1]) * (m[2].toLowerCase() === "kg" ? 1000 : 1);
      if (v > 0) return { grams: v, packs: 1, label: unitLabel(v) };
    }
  }
  return { grams: null, packs: 1, label: "-" };
}
const unitLabel = (g: number) => (g >= 1000 ? `${+(g / 1000).toFixed(2)}kg` : `${+g.toFixed(0)}g`);
// 중량·곱셈 토큰을 걷어낸 상품명 — 총중량 표의 '상품명' 축. "참돔순살(100g)"→"참돔순살", "대구순살 5x2"→"대구순살"
function baseName(name: string): string {
  const s = name
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:kg|g)?\s*[x×*]\s*\d+(?:\.\d+)?\s*\)/gi, "")
    .replace(/\d+(?:\.\d+)?\s*(?:kg|g)?\s*[x×*]\s*\d+(?:\.\d+)?/gi, "")
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:kg|g)\s*\)/gi, "")
    .replace(/\d+(?:\.\d+)?\s*(?:kg|g)/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ").trim();
  return s || name;
}

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

    // ── 상품명·옵션별 총중량 — 제조사가 원료 준비량을 바로 가늠하도록.
    //  묶음 기준: 상품명 + 옵션중량 두 축. 낱개와 묶음(1kg=100g*10)이 같은 소포장이면 한 줄로 합쳐지고,
    //  수량은 만들어야 할 소포장 개수다. 벌크(속성)는 상품명에 (벌크)가 붙어 줄이 나뉜다. ──
    ws.addRow([]);
    const wTitle = ws.addRow(["상품명·옵션별 총중량 (수량 = 소포장 개수)"]);
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

    const groups = new Map<string, { base: string; grams: number | null; wLabel: string; qty: number }>();
    for (const it of r.items) {
      const isBulk = (attrsMap.get(String(it.product_id)) || "").includes("벌크");
      const { grams, packs, label: wLabel } = parseUnit(isBulk, it.spec, it.name);
      const nameOnly = baseName(it.name);
      // 벌크는 상품명에 (벌크) 표기 — 이름에 이미 '벌크'가 있으면 중복해서 붙이지 않는다
      const base = isBulk && !nameOnly.includes("벌크") ? `${nameOnly}(벌크)` : nameOnly;
      const key = `${base}|${wLabel}`;
      const g = groups.get(key) || { base, grams, wLabel, qty: 0 };
      // 요청 수량 × 개당 팩 수 = 만들어야 할 소포장 개수(낱개는 packs=1 이라 그대로)
      g.qty += (Number(it.requested_qty) || 0) * packs;
      groups.set(key, g);
    }
    const wHeader = ws.addRow(["상품명", "옵션중량", "수량(팩)", "총중량(kg)", ""]);
    wHeader.font = { bold: true };
    wHeader.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }; c.alignment = { horizontal: "center" } });
    for (let col = 1; col <= 4; col++) wHeader.getCell(col).border = BOX;

    let sumKg = 0, sumQty = 0, unknown = 0;
    // 상품명 가나다순, 같은 상품명 안에서는 중량 오름차순(벌크 5kg×2 는 자연히 뒤)
    const sorted = [...groups.values()].sort((a, b) =>
      a.base.localeCompare(b.base, "ko") || (a.grams ?? Infinity) - (b.grams ?? Infinity));
    for (const g of sorted) {
      const kg = g.grams == null ? null : (g.grams * g.qty) / 1000;
      if (kg == null) unknown++; else sumKg += kg;
      sumQty += g.qty;
      const row = ws.addRow([g.base, g.wLabel, g.qty, kg == null ? "-" : +kg.toFixed(1), ""]);
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
