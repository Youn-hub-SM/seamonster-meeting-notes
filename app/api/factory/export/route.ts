import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho } from "@/app/lib/factory-db";
import { buildExportRows, SHIP_HEADERS, PROD_HEADERS, SHIP_DATE_COLS, PROD_DATE_COLS, type ExportTxn, type ExportProduct, type ExportRow } from "@/app/lib/factory-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?file=ship|prod&from=&to= — 기록을 ERP 엑셀 양식으로 내려받는다(모든 계정, 2026-11-20 대표 확정).
//  ship = '원료출고제품매출현황'(매출·재료·반품), prod = '매입생산현황'(매입·생산). 거래일이 기간 안이고 취소 안 된 기록.
//  대응 규칙은 app/lib/factory-export.ts. factory/011 이 적용돼 있어야 한다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
const PENDING_011 = "DB 준비 전입니다 — supabase/migrations/factory/011_txn_kinds.sql 을 적용하세요.";
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const n = (v: unknown) => (v == null ? null : Number(v));

// 1000행 한도를 넘어도 잘리지 않게 정렬을 고정해 페이지로 읽는다
async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; ; at += 1000) {
    const { data, error } = await make(at, at + 999);
    if (error) throw error;
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function GET(req: NextRequest) {
  try {
    await factoryWho(req);
    const sp = req.nextUrl.searchParams;
    const file = sp.get("file");
    const from = sp.get("from") || "", to = sp.get("to") || "";
    if (file !== "ship" && file !== "prod") return bad("양식을 고르세요.");
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return bad("기간이 올바르지 않습니다.");
    if ((Date.parse(to) - Date.parse(from)) / 86400e3 > MAX_DAYS) return bad(`한 번에 ${MAX_DAYS}일까지 내려받을 수 있습니다.`);

    const db = factoryDb();
    type Raw = Omit<ExportTxn, "kg" | "box_kg" | "unit_price"> & { kg: number | string; box_kg: number | string | null; unit_price: number | string | null };
    const cols = "id, product_id, txn_date, type, mfg_date, kg, box_kg, partner, tape_color, created_by, kind, storage, unit_price, move_id";
    let raw: Raw[];
    try {
      raw = await readAll<Raw>((a, b) => db.from("stock_txns").select(cols).is("cancelled_at", null).in("type", ["입고", "출고"])
        .gte("txn_date", from).lte("txn_date", to).order("txn_date").order("created_at").order("id").range(a, b));
    } catch (e) {
      if (/(kind|storage|unit_price|move_id)/.test(String((e as { message?: string })?.message))) return bad(PENDING_011, 503);
      throw e;
    }
    const txns: ExportTxn[] = raw.map((t) => ({ ...t, kg: Number(t.kg), box_kg: n(t.box_kg), unit_price: n(t.unit_price) }));

    const [prods, lotIns] = await Promise.all([
      readAll<{ id: string; name: string; spec: string | null; origin: string | null }>((a, b) => db.from("products").select("id, name, spec, origin").order("id").range(a, b)),
      // 로트의 입고일·테잎색 — 기간 밖 입고도 봐야 한다(오래전에 들어온 재고가 이번 기간에 나간다). 최신순으로 읽어 최근 테잎색을 쓴다
      readAll<{ product_id: string; mfg_date: string | null; box_kg: number | string | null; storage: string | null; txn_date: string; tape_color: string | null }>((a, b) =>
        db.from("stock_txns").select("product_id, mfg_date, box_kg, storage, txn_date, tape_color").is("cancelled_at", null).eq("type", "입고")
          .order("created_at", { ascending: false }).order("id").range(a, b)),
    ]);
    const moveIds = [...new Set(txns.map((t) => t.move_id).filter((x): x is string => !!x))];
    const moves: { move_id: string; type: "입고" | "출고"; storage: string | null }[] = [];
    for (let i = 0; i < moveIds.length; i += 200) {
      const { data, error } = await db.from("stock_txns").select("move_id, type, storage").in("move_id", moveIds.slice(i, i + 200));
      if (error) throw error;
      moves.push(...((data || []) as typeof moves));
    }

    const products = new Map<string, ExportProduct>(prods.map((p) => [p.id, { name: p.name, spec: p.spec, origin: p.origin }]));
    const { ship, prod } = buildExportRows(txns, products, lotIns.map((t) => ({ ...t, box_kg: n(t.box_kg) })), moves);
    const rows: ExportRow[] = file === "ship" ? ship : prod;
    const headers: readonly string[] = file === "ship" ? SHIP_HEADERS : PROD_HEADERS;
    const dateCols = new Set(file === "ship" ? SHIP_DATE_COLS : PROD_DATE_COLS);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("TEMP99");
    ws.addRow([...headers]);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow(headers.map((h) => {
        const v = r[h];
        if (v == null) return null;
        return dateCols.has(h) && typeof v === "string" ? new Date(`${v}T00:00:00Z`) : v;
      }));
    }
    headers.forEach((h, i) => {
      const c = ws.getColumn(i + 1);
      c.width = 13;
      if (dateCols.has(h)) c.numFmt = "yyyy-mm-dd";
    });
    const buf = await wb.xlsx.writeBuffer();
    const name = `${file === "ship" ? "원료출고제품매출현황" : "매입생산현황"}_${from}_${to}.xlsx`;
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[factory/export GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "엑셀 추출 실패") }, { status: 500 });
  }
}
