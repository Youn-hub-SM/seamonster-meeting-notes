// 도매 재고 생산 요청 — 서버 전용 로더(요청서 + 품목 + 입고집계 조립).
//  list 라우트와 [id] 라우트가 공용으로 사용.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductionRequest, PrItem, PrReceipt } from "./wholesale-production";

type AnyRow = Record<string, unknown>;
function one<T = AnyRow>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return (v ?? null) as T | null;
}

// opts.id 주면 단건, status 주면 상태 필터. 최신순.
export async function loadRequests(
  sb: SupabaseClient,
  opts: { id?: string; status?: string } = {},
): Promise<ProductionRequest[]> {
  let q = sb.from("production_requests").select("*").order("created_at", { ascending: false });
  if (opts.id) q = q.eq("id", opts.id);
  if (opts.status && opts.status !== "전체") q = q.eq("status", opts.status);
  const { data: reqs, error } = await q;
  if (error) throw error;
  const heads = (reqs ?? []) as AnyRow[];
  if (!heads.length) return [];

  const ids = heads.map((r) => r.id as string);
  const { data: itemsData, error: ie } = await sb
    .from("production_request_items")
    .select("id, request_id, product_id, requested_qty, memo, sort, products(sku, name, spec, unit)")
    .in("request_id", ids)
    .order("sort", { ascending: true });
  if (ie) throw ie;
  const items = (itemsData ?? []) as AnyRow[];

  const itemIds = items.map((i) => i.id as string);
  let receipts: AnyRow[] = [];
  if (itemIds.length) {
    const { data: rc, error: re } = await sb
      .from("production_receipts")
      .select("id, item_id, qty, receipt_date, memo, received_by, created_at")
      .in("item_id", itemIds)
      .order("created_at", { ascending: true });
    if (re) throw re;
    receipts = (rc ?? []) as AnyRow[];
  }

  const rcByItem = new Map<string, PrReceipt[]>();
  for (const r of receipts) {
    const k = r.item_id as string;
    const arr = rcByItem.get(k) ?? [];
    arr.push({
      id: r.id as string, item_id: k, qty: Number(r.qty) || 0,
      receipt_date: String(r.receipt_date), memo: (r.memo as string) ?? null,
      received_by: (r.received_by as string) ?? null, created_at: String(r.created_at),
    });
    rcByItem.set(k, arr);
  }

  const itemsByReq = new Map<string, PrItem[]>();
  for (const it of items) {
    const p = one<AnyRow>(it.products) ?? {};
    const rcs = rcByItem.get(it.id as string) ?? [];
    const received = rcs.reduce((s, r) => s + r.qty, 0);
    const pi: PrItem = {
      id: it.id as string, product_id: it.product_id as string,
      sku: (p.sku as string) ?? null, name: (p.name as string) ?? "(삭제된 품목)",
      spec: (p.spec as string) ?? null, unit: (p.unit as string) ?? "개",
      requested_qty: Number(it.requested_qty) || 0, received_qty: received,
      memo: (it.memo as string) ?? null, receipts: rcs,
    };
    const k = it.request_id as string;
    const arr = itemsByReq.get(k) ?? [];
    arr.push(pi);
    itemsByReq.set(k, arr);
  }

  return heads.map((r) => {
    const its = itemsByReq.get(r.id as string) ?? [];
    return {
      id: r.id as string, req_no: (r.req_no as string) ?? null, title: (r.title as string) ?? null,
      requested_by: (r.requested_by as string) ?? null, request_date: String(r.request_date),
      status: r.status as ProductionRequest["status"], memo: (r.memo as string) ?? null,
      created_by: (r.created_by as string) ?? null, created_at: String(r.created_at), updated_at: String(r.updated_at),
      items: its,
      total_requested: its.reduce((s, i) => s + i.requested_qty, 0),
      total_received: its.reduce((s, i) => s + i.received_qty, 0),
    };
  });
}
