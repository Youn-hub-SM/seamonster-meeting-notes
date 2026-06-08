import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/orders/production-summary
// 생산이 필요한 발주(발주확인/생산대기 + 생산요청/생산중)의 라인아이템을
// 생산예정일 주차별 → 품목+옵션별 총수량으로 집계.

type ProductRow = {
  product_name: string;
  spec: string;
  qty: number;
  companies: string[];
  order_ids: Set<string>;
};

type WeekBucket = {
  week_start: string; // "" = 생산일 미정
  week_end: string;
  label: string;
  total_qty: number;
  order_count: number;
  products: ProductRow[];
};

export async function GET(_req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("orders")
      .select(
        "id, production_date, status, " +
          "company:company_id(name), " +
          "order_items(product_name, spec, qty)"
      )
      .in("status", ["발주확인/생산대기", "생산요청/생산중"])
      .order("production_date", { ascending: true });
    if (error) throw error;

    type CompanyJoin = { name?: string };
    type ItemJoin = { product_name: string; spec: string | null; qty: number };
    type OrderRow = {
      id: string;
      production_date: string | null;
      status: string;
      company: CompanyJoin | CompanyJoin[] | null;
      order_items: ItemJoin[];
    };

    // 주차 버킷 맵: key = week_start ("" = 미정)
    const buckets = new Map<string, { meta: { week_start: string; week_end: string; label: string }; products: Map<string, ProductRow>; orderIds: Set<string> }>();

    for (const o of (data ?? []) as unknown as OrderRow[]) {
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const companyName = company?.name ?? "(미지정)";

      let weekKey = "";
      let meta = { week_start: "", week_end: "", label: "생산일 미정" };
      if (o.production_date) {
        const start = weekStartOf(o.production_date);
        const end = addDays(start, 6);
        weekKey = start;
        meta = { week_start: start, week_end: end, label: weekLabel(start, end) };
      }

      let bucket = buckets.get(weekKey);
      if (!bucket) {
        bucket = { meta, products: new Map(), orderIds: new Set() };
        buckets.set(weekKey, bucket);
      }
      bucket.orderIds.add(o.id);

      for (const it of o.order_items ?? []) {
        const spec = (it.spec ?? "").trim();
        const pkey = `${it.product_name}__${spec}`;
        let pr = bucket.products.get(pkey);
        if (!pr) {
          pr = { product_name: it.product_name, spec, qty: 0, companies: [], order_ids: new Set() };
          bucket.products.set(pkey, pr);
        }
        pr.qty += Number(it.qty) || 0;
        pr.order_ids.add(o.id);
        if (companyName && !pr.companies.includes(companyName)) pr.companies.push(companyName);
      }
    }

    // 정렬: 주차 오름차순(미정은 맨 뒤), 품목명 가나다
    const weeks: WeekBucket[] = Array.from(buckets.values())
      .sort((a, b) => {
        if (!a.meta.week_start && !b.meta.week_start) return 0;
        if (!a.meta.week_start) return 1;
        if (!b.meta.week_start) return -1;
        return a.meta.week_start.localeCompare(b.meta.week_start);
      })
      .map((b) => {
        const products = Array.from(b.products.values())
          .map((p) => ({
            product_name: p.product_name,
            spec: p.spec,
            qty: p.qty,
            companies: p.companies,
            order_count: p.order_ids.size,
          }))
          .sort(
            (x, y) =>
              x.product_name.localeCompare(y.product_name, "ko") ||
              x.spec.localeCompare(y.spec, "ko")
          );
        const total_qty = products.reduce((s, p) => s + p.qty, 0);
        return {
          week_start: b.meta.week_start,
          week_end: b.meta.week_end,
          label: b.meta.label,
          total_qty,
          order_count: b.orderIds.size,
          products: products as unknown as ProductRow[],
        };
      });

    return NextResponse.json({ ok: true, weeks });
  } catch (err) {
    console.error("[b2b/orders/production-summary]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// helpers (서버에서 Date.now() 안 쓰고 ISO 문자열만 다룸)
// ─────────────────────────────────────────────
function weekStartOf(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const day = d.getDay(); // 0=일
  const diff = day === 0 ? -6 : 1 - day; // 월요일 시작
  d.setDate(d.getDate() + diff);
  return toISO(d);
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekLabel(start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const sameMonth = s.getMonth() === e.getMonth();
  const y = s.getFullYear();
  if (sameMonth) {
    return `${y}년 ${s.getMonth() + 1}월 ${s.getDate()}일 ~ ${e.getDate()}일`;
  }
  return `${y}년 ${s.getMonth() + 1}월 ${s.getDate()}일 ~ ${e.getMonth() + 1}월 ${e.getDate()}일`;
}
