import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const cellNum = (v: unknown): number => {
  if (v && typeof v === "object" && "result" in (v as Record<string, unknown>)) v = (v as { result: unknown }).result;
  const n = Number(v); return Number.isFinite(n) ? n : 0;
};
const cellStr = (v: unknown): string => {
  if (v && typeof v === "object" && "result" in (v as Record<string, unknown>)) v = (v as { result: unknown }).result;
  if (v && typeof v === "object" && "text" in (v as Record<string, unknown>)) v = (v as { text: unknown }).text;
  return String(v ?? "").trim();
};

// POST (multipart file) — 백데이터 xlsx의 원가/중량 시트를 파싱해 sales_sku_cost 갱신(upsert).
//  헤더에서 '관리코드'·'중량'·'상품원가_단가'(또는 원가/단가)·'상품' 컬럼을 이름으로 찾음.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 첨부되지 않았습니다." }, { status: 400 });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());

    // exceljs .values 는 index 0 에 빈 슬롯(hole)이 있어 map 이 이를 건너뜀 → Array.from 으로 홀 제거.
    const headerOf = (w: ExcelJS.Worksheet) => { const raw = w.getRow(1).values as unknown[]; return Array.from({ length: raw.length }, (_, i) => cellStr(raw[i])); };
    // 관리코드 헤더가 있는 시트 선택(없으면 첫 시트)
    let ws = wb.worksheets[0];
    for (const w of wb.worksheets) {
      if (headerOf(w).some((h) => h.includes("관리코드"))) { ws = w; break; }
    }
    const header = headerOf(ws);
    const findCol = (...names: string[]) => header.findIndex((h) => names.some((n) => h.replace(/\s/g, "").includes(n)));
    const cCode = findCol("관리코드");
    const cWeight = findCol("중량");
    const cCost = findCol("상품원가_단가", "상품원가", "원가", "단가");
    const cName = findCol("상품명", "상품");
    if (cCode < 0 || cWeight < 0 || cCost < 0)
      return NextResponse.json({ ok: false, error: `필수 컬럼 인식 실패(관리코드/중량/상품원가). 헤더: ${header.filter(Boolean).join(", ")}` }, { status: 400 });

    const now = new Date().toISOString();
    const rows: { sku_code: string; product_name: string | null; weight_kg: number; cost_price: number; updated_at: string }[] = [];
    const seen = new Set<string>();
    let skippedBlank = 0;
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const vals = row.values as unknown[];
      const code = cellStr(vals[cCode]);
      if (!code || seen.has(code)) return;
      const weight = cellNum(vals[cWeight]);
      const cost = Math.round(cellNum(vals[cCost]));
      if (weight === 0 && cost === 0) { skippedBlank++; return; } // 중량·원가 미입력(빈 행)은 스킵 → 0 등록 방지
      seen.add(code);
      rows.push({ sku_code: code, product_name: cName >= 0 ? cellStr(vals[cName]) || null : null, weight_kg: weight, cost_price: cost, updated_at: now });
    });
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "유효한 원가 행이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("sales_sku_cost").upsert(rows.slice(i, i + 500), { onConflict: "sku_code" });
      if (error) return NextResponse.json({ ok: false, error: `저장 오류: ${error.message}. 043 적용 여부 확인.` }, { status: 500 });
    }
    const { count } = await sb.from("sales_sku_cost").select("sku_code", { count: "exact", head: true });
    return NextResponse.json({ ok: true, upserted: rows.length, skipped_blank: skippedBlank, total: count ?? null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
