import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { buildCnplus, type CodeInfo } from "@/app/lib/order-fulfill";
import { normalizeRates } from "@/app/lib/fulfill-rates";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cellVal(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return o.result ?? "";                 // 수식 → 결과값
    if ("text" in o) return o.text ?? "";                     // 하이퍼링크
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
  }
  return v;
}

async function toXlsxB64(headers: string[], rows: unknown[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString("base64");
}

// POST (multipart: file, keywords) — 주문 엑셀(A~M) → CNplus 일반/도착보장 파일 생성.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const keywords = String(form.get("keywords") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!file) return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });

    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(await file.arrayBuffer());
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });
    if (ws.columnCount < 13) return NextResponse.json({ ok: false, error: `열 수가 부족합니다(최소 13열, 현재 ${ws.columnCount}).` }, { status: 400 });

    // 헤더 1행 제외, A~M(13열) 데이터행
    const rows: unknown[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const arr: unknown[] = [];
      let any = false;
      for (let c = 1; c <= 13; c++) { const v = cellVal(ws.getRow(r).getCell(c)); arr.push(v); if (String(v).trim() !== "") any = true; }
      if (any) rows.push(arr);
    }
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "데이터 행이 없습니다." }, { status: 400 });

    // 택배 코드 = 상품마스터(courier_name·courier_weight)
    const sb = supabaseAdmin();
    const { data: codes, error } = await sb.from("products").select("sku, courier_name, courier_weight").not("sku", "is", null);
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (054 적용 확인)` }, { status: 500 });
    const codeMap = new Map<string, CodeInfo>();
    for (const c of codes ?? []) {
      const sku = String(c.sku || "").trim();
      if (!sku) continue;
      codeMap.set(sku.toUpperCase(), { courier_name: c.courier_name || "", order_weight: Number(c.courier_weight) || 0 });
    }

    // 요율(설정) 로드 — 미설정이면 기본값
    const { data: rateRow } = await sb.from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle();
    const rates = normalizeRates(rateRow?.value ?? {});

    const res = buildCnplus(rows, codeMap, keywords, rates);

    const d = new Date(Date.now() + 9 * 3600e3);
    const stamp = `${d.toISOString().slice(0, 10).replace(/-/g, "")}_${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const normalB64 = await toXlsxB64(res.headers, res.normal);
    const guarB64 = res.guarantee.length ? await toXlsxB64(res.headers, res.guarantee) : null;

    // 택배량 집계 xlsx (박스종류 × 일반/도착보장)
    const parcelRows: unknown[][] = res.parcelSummary.map((p) => [p.category, p.normal, p.guarantee, p.normal + p.guarantee]);
    parcelRows.push(["합계", res.stats.parcels - res.stats.parcelsGuar, res.stats.parcelsGuar, res.stats.parcels]);
    const parcelB64 = await toXlsxB64(["박스종류", "일반", "도착보장", "합계"], parcelRows);

    return NextResponse.json({
      ok: true,
      stats: res.stats,
      fees: res.fees,
      parcelSummary: res.parcelSummary,
      addressWarnings: res.addressWarnings,
      unmatched: res.unmatched,
      codeCount: codeMap.size,
      files: {
        normal: { name: `cnplus_출력_${stamp}.xlsx`, b64: normalB64 },
        guarantee: guarB64 ? { name: `[도착보장]cnplus_출력_${stamp}.xlsx`, b64: guarB64 } : null,
        parcel: { name: `택배량_${stamp}.xlsx`, b64: parcelB64 },
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "생성 실패") }, { status: 500 });
  }
}
