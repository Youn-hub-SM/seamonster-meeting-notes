import type { SupabaseClient } from "@supabase/supabase-js";
import { logProductionReceipt, logProductionRequestStatusChanged } from "./b2b-activity";

// 입고 → 생산 요청 자동 매칭 — 입고 창구를 '입고 및 출고'로 단일화하면서 이행률 추적을 유지하는 다리.
//  '입고'(완료) 원장이 기록될 때, 같은 품목의 열린 요청(요청·진행중)에 오래된 요청부터(FIFO)
//  잔여 수량만큼 배분해 production_receipts 증거를 남긴다. 요청에 없는 품목·잔여 초과분은
//  그냥 일반 입고로 남는다(연결 없음). 소수 수량은 정수 부분만 매칭(요청 수량이 정수 단위).
//
//  취소 정합성: receipts.inv_txn_id 가 원장에 cascade(083) — 입고/출고에서 그 입고를 취소
//  (원장 삭제)하면 증거도 함께 지워져 이행률이 자동 원복된다.
//
//  실패해도 입고 자체를 막지 않는다 — 호출부는 try/catch 로 감싸 fire-and-forget.

export type AllocEntry = {
  inv_txn_id: string;
  product_id: string;
  qty: number;            // 부호 있는 원장 수량 — 양수(입고)만 매칭
  receipt_date?: string;  // 원장 거래일(YYYY-MM-DD)
};

// 이행 규칙(2026-07-29 확정):
//  · 입고(도소매 무관)          → '재고 보충'(제조사 요청) 이행 — 제조사가 만들어 보냈는가
//  · 소매→도매 이전(도매 입고편) → '도매 납품'(도매 요청) 이행 — 생산 담당자가 도매로 옮겼는가
export async function allocateReceiptsToOpenRequests(
  sb: SupabaseClient,
  entries: AllocEntry[],
  actor: string | null,
  opts?: { purpose?: "재고 보충" | "도매 납품"; memo?: string },
): Promise<void> {
  const positive = entries.filter((e) => e.inv_txn_id && e.product_id && Math.floor(e.qty) > 0);
  if (!positive.length) return;
  const pids = [...new Set(positive.map((e) => e.product_id))];

  // 품목명(알림용)
  const nameById = new Map<string, string>();
  try {
    const { data } = await sb.from("products").select("id, name").in("id", pids);
    for (const p of data ?? []) nameById.set(p.id as string, p.name as string);
  } catch { /* 이름 없이 진행 */ }

  // 열린 요청 품목(요청·진행중) — 오래된 요청부터. 용도 필터(082) 미적용 환경이면 용도 무관 폴백.
  const query = (withPurpose: boolean) => {
    let q = sb
      .from("production_request_items")
      .select("id, request_id, requested_qty, product_id, production_requests!inner(id, req_no, status, request_date, created_at)")
      .in("product_id", pids)
      .in("production_requests.status", ["요청", "진행중"]);
    if (withPurpose && opts?.purpose) q = q.eq("production_requests.purpose", opts.purpose);
    return q;
  };
  let { data: itemsRaw, error: ie } = await query(true);
  if (ie && /purpose/i.test(ie.message)) ({ data: itemsRaw, error: ie } = await query(false)); // 082 미적용 폴백
  if (ie || !itemsRaw?.length) return;

  type Head = { id: string; req_no: string | null; status: string; request_date: string; created_at: string };
  type OpenItem = { id: string; request_id: string; requested_qty: number; product_id: string; head: Head };
  const items: OpenItem[] = itemsRaw
    .map((r) => {
      const rel = (r as { production_requests?: Head | Head[] | null }).production_requests;
      const head = Array.isArray(rel) ? rel[0] : rel;
      return head ? { id: r.id as string, request_id: r.request_id as string, requested_qty: Number(r.requested_qty) || 0, product_id: r.product_id as string, head } : null;
    })
    .filter((x): x is OpenItem => !!x)
    .sort((a, b) => a.head.request_date.localeCompare(b.head.request_date) || a.head.created_at.localeCompare(b.head.created_at));

  // 기존 입고 누계 → 잔여
  const received = new Map<string, number>();
  try {
    const { data: rcs } = await sb.from("production_receipts").select("item_id, qty").in("item_id", items.map((i) => i.id));
    for (const rc of rcs ?? []) received.set(rc.item_id as string, (received.get(rc.item_id as string) || 0) + (Number(rc.qty) || 0));
  } catch { return; }
  const remaining = new Map<string, number>();
  for (const it of items) remaining.set(it.id, Math.max(0, it.requested_qty - (received.get(it.id) || 0)));

  const startedRequests = new Set<string>(); // 이번 호출에서 요청→진행중 전환한 요청(중복 전환 방지)

  for (const e of positive) {
    let left = Math.floor(e.qty);
    for (const it of items) {
      if (left <= 0) break;
      if (it.product_id !== e.product_id) continue;
      const rem = remaining.get(it.id) || 0;
      if (rem <= 0) continue;
      const alloc = Math.min(rem, left);

      const row: Record<string, unknown> = {
        request_id: it.request_id, item_id: it.id, qty: alloc,
        memo: opts?.memo || "입고/출고 연동", received_by: actor, inv_txn_id: e.inv_txn_id,
      };
      if (e.receipt_date && /^\d{4}-\d{2}-\d{2}$/.test(e.receipt_date)) row.receipt_date = e.receipt_date;
      const { error: re } = await sb.from("production_receipts").insert(row);
      if (re) { console.warn("[production-allocate] receipt insert failed", re.message); continue; }

      remaining.set(it.id, rem - alloc);
      left -= alloc;

      const reqNo = it.head.req_no || "";
      await logProductionReceipt(reqNo, nameById.get(e.product_id) || "품목", alloc, actor);
      if (it.head.status === "요청" && !startedRequests.has(it.request_id)) {
        startedRequests.add(it.request_id);
        await sb.from("production_requests").update({ status: "진행중", updated_at: new Date().toISOString() }).eq("id", it.request_id).eq("status", "요청");
        await logProductionRequestStatusChanged(reqNo, "요청", "진행중", actor);
        it.head.status = "진행중";
      }
    }
  }
}
