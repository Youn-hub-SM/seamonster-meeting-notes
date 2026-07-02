// 매출 백필(1회성) — 구글시트 rawdata를 xlsx/csv로 내보낸 파일을 Supabase(sales_orders/sales_customers)에 적재.
//  실행: npx tsx scripts/backfill-sales.ts <파일경로> [source태그]
//  필요 env(.env.local 또는 셸): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SALES_PII_PEPPER
//  ⚠️ SALES_PII_PEPPER 는 웹앱(Vercel)과 '완전히 동일한 값'이어야 재구매 판정이 이어집니다.
//  멱등: row_hash UNIQUE + ignoreDuplicates → 중단 후 재실행해도 중복 없이 이어받음.
import fs from "fs";
import path from "path";
import { parseSalesFile } from "../app/lib/sales-parse";
import { normalizeRow, type SalesOrderRow, type SalesCustomerRow } from "../app/lib/sales-normalize";

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

async function main() {
  loadEnv();
  const filePath = process.argv[2];
  if (!filePath) { console.error("사용법: npx tsx scripts/backfill-sales.ts <엑셀/CSV 경로> [source태그]"); process.exit(1); }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("환경변수 없음: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  if (!process.env.SALES_PII_PEPPER) { console.error("환경변수 없음: SALES_PII_PEPPER (웹앱과 동일 값 필수)"); process.exit(1); }

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const buf = fs.readFileSync(path.resolve(filePath));
  const file = new File([buf], path.basename(filePath));
  console.log(`파일 읽는 중: ${filePath}`);
  const { rows } = await parseSalesFile(file);
  console.log(`총 ${rows.length.toLocaleString()}행 파싱`);

  const source = process.argv[3] || `backfill-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const seen = new Set<string>();
  const orders: (SalesOrderRow & { source: string })[] = [];
  const custMap = new Map<string, { c: SalesCustomerRow; min: string; max: string }>();
  let invalid = 0, dupInFile = 0;
  for (const raw of rows) {
    const nr = normalizeRow(raw);
    if (!nr.ok || !nr.order) { invalid++; continue; }
    if (seen.has(nr.order.row_hash)) { dupInFile++; continue; }
    seen.add(nr.order.row_hash);
    orders.push({ ...nr.order, source });
    if (nr.customer) {
      const ex = custMap.get(nr.customer.customer_key);
      if (!ex) custMap.set(nr.customer.customer_key, { c: nr.customer, min: nr.customer.order_date, max: nr.customer.order_date });
      else { if (nr.customer.order_date < ex.min) ex.min = nr.customer.order_date; if (nr.customer.order_date > ex.max) ex.max = nr.customer.order_date; if (nr.customer.customer_name) ex.c.customer_name = nr.customer.customer_name; }
    }
  }
  console.log(`정규화: 유효 ${orders.length.toLocaleString()} · 무효 ${invalid.toLocaleString()} · 파일내중복 ${dupInFile.toLocaleString()}`);

  // sales_orders 멱등 upsert(1000행 청크)
  let done = 0;
  for (let i = 0; i < orders.length; i += 1000) {
    const { error } = await sb.from("sales_orders").upsert(orders.slice(i, i + 1000), { onConflict: "row_hash", ignoreDuplicates: true });
    if (error) { console.error("\n적재 오류:", error.message); process.exit(1); }
    done += Math.min(1000, orders.length - i);
    process.stdout.write(`\r적재 ${done.toLocaleString()}/${orders.length.toLocaleString()}`);
  }
  console.log("\nsales_orders 적재 완료");

  // sales_customers 병합 upsert
  const keys = [...custMap.keys()];
  const existing = new Map<string, { first_seen_date: string | null; last_seen_date: string | null }>();
  for (let i = 0; i < keys.length; i += 1000) {
    const { data } = await sb.from("sales_customers").select("customer_key, first_seen_date, last_seen_date").in("customer_key", keys.slice(i, i + 1000));
    for (const r of data || []) existing.set(r.customer_key, r);
  }
  const custRows = keys.map((k) => {
    const v = custMap.get(k)!; const ex = existing.get(k);
    const first = ex?.first_seen_date && ex.first_seen_date < v.min ? ex.first_seen_date : v.min;
    const last = ex?.last_seen_date && ex.last_seen_date > v.max ? ex.last_seen_date : v.max;
    return { customer_key: k, phone: v.c.phone, phone_digits: v.c.phone_digits, customer_name: v.c.customer_name, first_seen_date: first, last_seen_date: last, updated_at: new Date().toISOString() };
  });
  for (let i = 0; i < custRows.length; i += 1000) {
    const { error } = await sb.from("sales_customers").upsert(custRows.slice(i, i + 1000), { onConflict: "customer_key" });
    if (error) { console.error("고객 적재 오류:", error.message); process.exit(1); }
  }
  console.log(`sales_customers ${custRows.length.toLocaleString()}명 upsert`);

  const { data: b } = await sb.rpc("sales_date_bounds");
  const bounds = Array.isArray(b) && b[0] ? b[0] : null;
  console.log(`\n완료. 현재 sales_orders 총 ${bounds ? Number(bounds.total_rows).toLocaleString() : "?"}행 (기간 ${bounds?.min_date ?? "?"} ~ ${bounds?.max_date ?? "?"})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
