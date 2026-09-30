import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005 } from "@/app/lib/factory-db";
import { planFactoryImport } from "@/app/lib/factory-product-xlsx";
import type { FactoryProduct } from "@/app/lib/factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) {
      if (o.result instanceof Date) return o.result.toISOString().slice(0, 10);
      if (typeof o.result === "object") return ""; // 수식 오류(#N/A 등) — '[object Object]' 글자가 들어가지 않게 빈 칸으로
      return String(o.result).trim();
    }
    return "";
  }
  return String(v).trim();
}

// POST (multipart: file) — 파도소리 상품마스터 엑셀 분석 → 변경 미리보기(관리자). DB 는 바꾸지 않는다.
//  씨몬스터 상품 마스터 업로드(/api/b2b/products/import)와 같은 방식: 신규·변경(칸별 이전→이후)·동일·오류(행 번호).
//  매칭 규칙은 planFactoryImport(factory-product-xlsx.ts).
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "관리자만 업로드할 수 있습니다." }, { status: 403 });
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "엑셀 파일을 첨부하세요." }, { status: 400 });
    const buf = Buffer.from(await (file as File).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    } catch {
      return NextResponse.json({ ok: false, error: "엑셀(.xlsx) 파일을 읽을 수 없습니다." }, { status: 400 });
    }
    const ws = wb.worksheets[0];
    if (!ws) return NextResponse.json({ ok: false, error: "시트를 찾을 수 없습니다." }, { status: 400 });

    const colByHeader = new Map<string, number>();
    ws.getRow(1).eachCell((cell, col) => colByHeader.set(cellStr(cell.value), col));
    if (!colByHeader.has("SKU") || !(colByHeader.has("품목") || colByHeader.has("품목명")))
      return NextResponse.json({ ok: false, error: "헤더에 'SKU'·'품목' 이 없습니다. [엑셀 추출]로 받은 양식 그대로 업로드하세요." }, { status: 400 });

    // 값 있는 행만(서식만 있는 빈 행·빈 번호는 eachRow 가 건너뛴다) — 한도도 실제 데이터 행만 센다
    const rows: { line: number; get: (h: string) => string }[] = [];
    ws.eachRow((row, r) => {
      if (r < 2) return;
      const get = (h: string) => { const c = colByHeader.get(h); return c ? cellStr(row.getCell(c).value) : ""; };
      if (!get("ID") && !get("SKU") && !get("품목") && !get("품목명")) return;
      rows.push({ line: r, get });
    });
    if (rows.length > 5000) return NextResponse.json({ ok: false, error: "한 번에 5000행까지 올릴 수 있습니다." }, { status: 400 });

    const { data, error } = await factoryDb().from("products").select("*");
    if (error) throw error;
    const plan = planFactoryImport(rows, (data || []) as FactoryProduct[], (h) => colByHeader.has(h));
    return NextResponse.json({ ok: true, ...plan });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    console.error("[factory/products import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "파일 분석 실패") }, { status: 500 });
  }
}
