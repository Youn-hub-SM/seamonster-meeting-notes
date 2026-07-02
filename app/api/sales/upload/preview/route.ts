import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { parseSalesFile } from "@/app/lib/sales-parse";
import { normalizeRow, type SalesOrderRow } from "@/app/lib/sales-normalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PREVIEW = 50000;   // 대량은 백필 스크립트로 유도

// 파일 파싱→정규화→파일내/DB 중복 계산. DB 미기록(순수 미리보기).
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 첨부되지 않았습니다." }, { status: 400 });

    const { rows } = await parseSalesFile(file);
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "행을 찾지 못했습니다. 헤더(주문일자·결제금액 등)가 포함된 파일인지 확인하세요." }, { status: 400 });
    if (rows.length > MAX_PREVIEW) return NextResponse.json({ ok: false, error: `행이 ${rows.length.toLocaleString()}개입니다. 대량 이관(과거 전체)은 백필 스크립트를 사용하세요. 웹 업로드는 최대 ${MAX_PREVIEW.toLocaleString()}행.` }, { status: 413 });

    const seen = new Set<string>();
    const orders: SalesOrderRow[] = [];
    const errors: string[] = [];
    let dupInFile = 0, invalid = 0;
    for (const raw of rows) {
      let nr;
      try { nr = normalizeRow(raw); }
      catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }); }
      if (!nr.ok || !nr.order) { invalid++; if (errors.length < 15) errors.push(nr.error || "정규화 실패"); continue; }
      if (seen.has(nr.order.row_hash)) { dupInFile++; continue; }
      seen.add(nr.order.row_hash);
      orders.push(nr.order);
    }

    // DB 중복(row_hash 존재) 조회 — 1000행 청크
    const sb = supabaseAdmin();
    const hashes = orders.map((o) => o.row_hash);
    let dupInDb = 0;
    for (let i = 0; i < hashes.length; i += 1000) {
      const { data, error } = await sb.from("sales_orders").select("row_hash").in("row_hash", hashes.slice(i, i + 1000));
      if (error) return NextResponse.json({ ok: false, error: `DB 조회 오류: ${error.message} (마이그레이션 039 적용 확인)` }, { status: 500 });
      dupInDb += data?.length || 0;
    }

    const dates = orders.map((o) => o.order_date).sort();
    const channels = [...new Set(orders.map((o) => o.channel).filter(Boolean))];
    const revenue = orders.reduce((s, o) => s + o.subtotal_amount, 0);
    const sample = orders.slice(0, 30).map((o) => ({
      order_date: o.order_date, channel: o.channel, order_id: o.order_id,
      product_name: o.product_name, sku_code: o.sku_code, quantity: o.quantity, subtotal_amount: o.subtotal_amount,
    }));

    return NextResponse.json({
      ok: true,
      summary: { total_rows: rows.length, valid: orders.length, invalid, dup_in_file: dupInFile, dup_in_db: dupInDb, new_rows: orders.length - dupInDb, revenue },
      date_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      channels, sample, errors,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
