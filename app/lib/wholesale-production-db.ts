// 도매 재고 생산 요청 — 서버 전용 로더(요청서 + 품목 + 입고집계 조립).
//  list 라우트와 [id] 라우트가 공용으로 사용.
import type { SupabaseClient } from "@supabase/supabase-js";
import { UNREQUESTED_ITEM_MEMO, toPrPurpose, type ProductionRequest, type PrItem, type PrReceipt, type PrPurpose, PURPOSE_NOTE } from "./wholesale-production";

type AnyRow = Record<string, unknown>;
function one<T = AnyRow>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return (v ?? null) as T | null;
}

// 요청서 상세를 Teams 게시물 본문용 여러 줄 텍스트로 — 알림에 품목·수량·이행률까지 싣는다(2026-09-16 대표 요청).
//  줄 형식은 b2b-teams 의 toAdaptiveCard(줄 단위 TextBlock)와 맞물린다. 개인정보 없음.
export function formatRequestDetail(r: ProductionRequest): string {
  const lines: string[] = [];
  const head: string[] = [];
  head.push(`용도 ${PURPOSE_NOTE[toPrPurpose(r.purpose)]}`);
  if (r.due_date) head.push(`마감 ${r.due_date}`);
  if (r.assignee) head.push(`담당 ${r.assignee}`);
  lines.push(head.join(" · "));
  for (const it of r.items.slice(0, 20)) {
    const spec = it.spec ? ` ${it.spec}` : "";
    if (it.requested_qty <= 0 && it.memo === UNREQUESTED_ITEM_MEMO) {
      lines.push(`- ${it.name}${spec} ${UNREQUESTED_ITEM_MEMO} — 입고 ${it.received_qty.toLocaleString()}`);
      continue;
    }
    const recv = it.received_qty > 0 ? ` — 입고 ${it.received_qty.toLocaleString()} · 잔여 ${Math.max(0, Math.round((it.requested_qty - it.received_qty) * 100) / 100).toLocaleString()}` : "";
    lines.push(`- ${it.name}${spec} ×${it.requested_qty.toLocaleString()}${recv}${it.memo ? ` (${it.memo})` : ""}`);
  }
  if (r.items.length > 20) lines.push(`- 외 ${r.items.length - 20}개 품목`);
  const pctv = r.total_requested > 0 ? Math.round((r.total_received / r.total_requested) * 100) : 0;
  const autoCount = r.items.filter((it) => it.requested_qty <= 0 && it.memo === UNREQUESTED_ITEM_MEMO).length;
  lines.push(`합계 ${r.items.length - autoCount}품목${autoCount ? ` (+요청서에 없음 ${autoCount})` : ""} · 요청 ${r.total_requested.toLocaleString()} · 입고 ${r.total_received.toLocaleString()} (${pctv}%)`);
  if (r.memo) lines.push(`메모: ${r.memo}`);
  return lines.join("\n");
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
    // '[요청서에 없음]' 자동 줄(요청수량 0)은 입고가 전부 취소돼 비면 없는 줄로 본다 — 어디에도 안 보이고,
    //  수정 저장 시 자연히 정리된다(입고 기록이 없으니 삭제 가능).
    const its = (itemsByReq.get(r.id as string) ?? []).filter((it) => !(it.requested_qty <= 0 && it.received_qty <= 0 && it.memo === UNREQUESTED_ITEM_MEMO));
    // 합계·이행률은 요청한 줄만 — 요청서에 없던 품목의 입고를 더하면 이행률이 실제보다 부풀어 보인다
    const requestedLines = its.filter((it) => it.requested_qty > 0);
    return {
      id: r.id as string, req_no: (r.req_no as string) ?? null, title: (r.title as string) ?? null,
      purpose: toPrPurpose(r.purpose), // 082·113·115 미적용/기존 행·모르는 값 → 재고 보충
      requested_by: (r.requested_by as string) ?? null, request_date: String(r.request_date),
      due_date: (r.due_date as string) ?? null, // 생산종료일=마감(071 미적용이면 null)
      prod_start: (r.prod_start as string) ?? null, // 생산시작일(118 미적용이면 null — 창 시작은 신청일)
      status: r.status as ProductionRequest["status"], assignee: (r.assignee as string) ?? null, memo: (r.memo as string) ?? null,
      created_by: (r.created_by as string) ?? null, created_at: String(r.created_at), updated_at: String(r.updated_at),
      items: its,
      total_requested: requestedLines.reduce((s, i) => s + i.requested_qty, 0),
      total_received: requestedLines.reduce((s, i) => s + i.received_qty, 0),
    };
  });
}
