import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { parseSalesFile } from "@/app/lib/sales-parse";
import { normalizeRow, type SalesOrderRow, type SalesCustomerRow } from "@/app/lib/sales-normalize";
import { logSalesUpload, currentActor } from "@/app/lib/b2b-activity";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_APPLY = 50000;

// 파일 재파싱 → row_hash 멱등 upsert(중복 무시) + 고객 조회 테이블 병합 upsert.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "파일이 첨부되지 않았습니다." }, { status: 400 });

    const { rows } = await parseSalesFile(file);
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "행을 찾지 못했습니다." }, { status: 400 });
    if (rows.length > MAX_APPLY) return NextResponse.json({ ok: false, error: `행이 너무 많습니다(${rows.length.toLocaleString()}). 대량은 백필 스크립트로.` }, { status: 413 });

    const seen = new Set<string>();
    const orders: SalesOrderRow[] = [];
    // 고객: key별 최소/최대 날짜·이름 병합
    const custMap = new Map<string, { c: SalesCustomerRow; min: string; max: string }>();
    for (const raw of rows) {
      const nr = normalizeRow(raw);
      if (!nr.ok || !nr.order) continue;
      if (seen.has(nr.order.row_hash)) continue;
      seen.add(nr.order.row_hash);
      orders.push(nr.order);
      if (nr.customer) {
        const ex = custMap.get(nr.customer.customer_key);
        if (!ex) custMap.set(nr.customer.customer_key, { c: nr.customer, min: nr.customer.order_date, max: nr.customer.order_date });
        else { if (nr.customer.order_date < ex.min) ex.min = nr.customer.order_date; if (nr.customer.order_date > ex.max) ex.max = nr.customer.order_date; if (nr.customer.customer_name) ex.c.customer_name = nr.customer.customer_name; }
      }
    }

    const sb = supabaseAdmin();

    // 삽입 전 기존 개수(정확한 신규 건수 산출)
    const hashes = orders.map((o) => o.row_hash);
    let existed = 0;
    for (let i = 0; i < hashes.length; i += 1000) {
      const { data, error } = await sb.from("sales_orders").select("row_hash").in("row_hash", hashes.slice(i, i + 1000));
      if (error) return NextResponse.json({ ok: false, error: `DB 조회 오류: ${error.message}` }, { status: 500 });
      existed += data?.length || 0;
    }

    // 배치 id — 이 업로드가 '새로 삽입한' 행에만 태깅(멱등이라 기존 중복행은 미변경) → 되돌리기 시 정확히 이 배치분만 삭제.
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // yyyymmddhhmmss(UTC)
    const batchId = `web-${stamp}-${randomUUID().slice(0, 4)}`;

    // 멱등 upsert(중복 무시)
    for (let i = 0; i < orders.length; i += 1000) {
      const chunk = orders.slice(i, i + 1000).map((o) => ({ ...o, source: "web", upload_batch: batchId }));
      const { error } = await sb.from("sales_orders").upsert(chunk, { onConflict: "row_hash", ignoreDuplicates: true });
      if (error) return NextResponse.json({ ok: false, error: `적재 오류: ${error.message}` }, { status: 500 });
    }

    // 고객 조회 테이블 병합 upsert(first/last/name). order_count는 검색 시 실시간 계산 → 여기선 미유지.
    const keys = [...custMap.keys()];
    const existing = new Map<string, { first_seen_date: string | null; last_seen_date: string | null }>();
    for (let i = 0; i < keys.length; i += 1000) {
      const { data } = await sb.from("sales_customers").select("customer_key, first_seen_date, last_seen_date").in("customer_key", keys.slice(i, i + 1000));
      for (const r of data || []) existing.set(r.customer_key, { first_seen_date: r.first_seen_date, last_seen_date: r.last_seen_date });
    }
    const custRows = keys.map((k) => {
      const v = custMap.get(k)!;
      const ex = existing.get(k);
      const first = ex?.first_seen_date && ex.first_seen_date < v.min ? ex.first_seen_date : v.min;
      const last = ex?.last_seen_date && ex.last_seen_date > v.max ? ex.last_seen_date : v.max;
      return { customer_key: k, phone: v.c.phone, phone_digits: v.c.phone_digits, customer_name: v.c.customer_name, first_seen_date: first, last_seen_date: last, updated_at: new Date().toISOString() };
    });
    for (let i = 0; i < custRows.length; i += 1000) {
      const { error } = await sb.from("sales_customers").upsert(custRows.slice(i, i + 1000), { onConflict: "customer_key" });
      if (error) return NextResponse.json({ ok: false, error: `고객 저장 오류: ${error.message}` }, { status: 500 });
    }

    const inserted = orders.length - existed;
    const skipped = rows.length - inserted;
    // 되돌리기 대상이 있을 때(신규 삽입>0)만 업로드 이력 기록.
    if (inserted > 0) {
      await sb.from("sales_uploads").insert({
        id: batchId, filename: file.name, total_rows: rows.length,
        inserted, skipped, uploaded_by: await currentActor(), status: "active",
      });
    }
    await logSalesUpload(file.name, inserted, skipped);
    const { data: bounds } = await sb.rpc("sales_date_bounds");
    const totalAfter = Array.isArray(bounds) && bounds[0] ? (bounds[0].total_rows as number) : null;
    return NextResponse.json({ ok: true, inserted, skipped, total_after: totalAfter, batch_id: inserted > 0 ? batchId : null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
