import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/b2b/orders/production-summary
// 생산이 필요한 발주(발주확인/생산대기 + 생산요청/생산중)의 라인아이템을
// 생산예정일(일자)별 → 품목+옵션별 총수량으로 집계.
//  → "며칠에 무엇을 얼마나 생산해야 하는가"를 하루 단위로 보여줌.

type ProductRow = {
  product_name: string;
  spec: string;
  qty: number;
  companies: string[];
  order_count: number;
};

type DayBucket = {
  date: string; // "" = 생산일 미정
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

    // 일자 버킷 맵: key = production_date ("" = 미정)
    const buckets = new Map<
      string,
      { products: Map<string, ProductRow>; orderIds: Set<string> }
    >();

    for (const o of (data ?? []) as unknown as OrderRow[]) {
      const company = Array.isArray(o.company) ? o.company[0] : o.company;
      const companyName = company?.name ?? "(미지정)";

      const dayKey = o.production_date ?? "";

      let bucket = buckets.get(dayKey);
      if (!bucket) {
        bucket = { products: new Map(), orderIds: new Set() };
        buckets.set(dayKey, bucket);
      }
      bucket.orderIds.add(o.id);

      for (const it of o.order_items ?? []) {
        const spec = (it.spec ?? "").trim();
        const pkey = `${it.product_name}__${spec}`;
        let pr = bucket.products.get(pkey);
        if (!pr) {
          pr = { product_name: it.product_name, spec, qty: 0, companies: [], order_ids: new Set() } as unknown as ProductRow & { order_ids: Set<string> };
          bucket.products.set(pkey, pr);
        }
        const prx = pr as ProductRow & { order_ids: Set<string> };
        prx.qty += Number(it.qty) || 0;
        prx.order_ids.add(o.id);
        if (companyName && !prx.companies.includes(companyName)) prx.companies.push(companyName);
      }
    }

    // 정렬: 날짜 오름차순(미정은 맨 뒤), 품목명 가나다
    const days: DayBucket[] = Array.from(buckets.entries())
      .sort((a, b) => {
        if (!a[0] && !b[0]) return 0;
        if (!a[0]) return 1;
        if (!b[0]) return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([date, b]) => {
        const products = Array.from(b.products.values())
          .map((p) => {
            const px = p as ProductRow & { order_ids: Set<string> };
            return {
              product_name: px.product_name,
              spec: px.spec,
              qty: px.qty,
              companies: px.companies,
              order_count: px.order_ids.size,
            };
          })
          .sort(
            (x, y) =>
              x.product_name.localeCompare(y.product_name, "ko") ||
              x.spec.localeCompare(y.spec, "ko")
          );
        const total_qty = products.reduce((s, p) => s + p.qty, 0);
        return {
          date,
          label: date ? dayLabel(date) : "생산일 미정",
          total_qty,
          order_count: b.orderIds.size,
          products,
        };
      });

    return NextResponse.json({ ok: true, days });
  } catch (err) {
    console.error("[b2b/orders/production-summary]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// helpers (서버에서 ISO 문자열만 다룸)
// ─────────────────────────────────────────────
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function dayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const wd = WEEKDAYS[d.getDay()];
  return `${m}월 ${day}일 (${wd})`;
}
