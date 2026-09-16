import type { SupabaseClient } from "@supabase/supabase-js";
import { logProductionReceipt, logProductionRequestStatusChanged } from "./b2b-activity";

// 입고 → 생산 요청 자동 매칭 — 입고 창구를 '입고 및 출고'로 단일화하면서 이행률 추적을 유지하는 다리.
//  '입고'(완료) 원장이 기록될 때, 같은 품목의 열린 요청(요청·진행중)에 오래된 요청부터(FIFO)
//  잔여 수량만큼 배분해 production_receipts 증거를 남긴다. 요청에 없는 품목·잔여 초과분은
//  그냥 일반 입고로 남는다(연결 없음). 수량은 소수 둘째 자리까지 매칭(104 — 요청·입고 모두 numeric).
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

// 링크 삽입 — 102 유니크(item_id, inv_txn_id) 적용 환경에선 이미 있는 링크와 충돌 시 무시(DO NOTHING)해
//  동시 실행(이벤트/소급 매칭 겹침)의 이중 집계를 DB 가 막는다. inserted=false 면 충돌로 무시된 것 —
//  호출부가 '경합 중복'인지 '정당한 증액(top-up)'인지 재판정한다(topUpPair). 미적용 환경은 insert 폴백.
async function insertReceiptOnce(sb: SupabaseClient, row: Record<string, unknown>): Promise<{ error: { message: string } | null; inserted: boolean }> {
  const up = await sb.from("production_receipts").upsert(row, { onConflict: "item_id,inv_txn_id", ignoreDuplicates: true }).select("id");
  if (up.error && /no unique|exclusion constraint|on conflict/i.test(up.error.message)) {
    const ins = await sb.from("production_receipts").insert(row);
    return { error: ins.error, inserted: !ins.error };
  }
  return { error: up.error, inserted: !!up.data?.length };
}

// 유니크 쌍(item_id, inv_txn_id) 충돌 시 재판정 — DB 를 새로 읽어 '지금 추가로 필요한 만큼만'
//  기존 링크 행에 합산한다. 경합 중복(같은 배분이 두 곳에서 계산됨)이면 최신 합계에 이미 반영돼
//  추가분이 0 이 되고, 수량 증액(top-up: 요청수량을 늘려 같은 입고의 잔여를 더 써야 하는 경우)이면
//  그 차이만 합산된다 — DO NOTHING 만으로는 증액이 무증상으로 삼켜진다(재검증 F1).
async function topUpPair(
  sb: SupabaseClient, itemId: string, requestedQty: number, txnId: string, txnQty: number,
): Promise<{ applied: number; freshRem: number; freshLeft: number } | null> {
  try {
    const [pair, byTxn, byItem] = await Promise.all([
      sb.from("production_receipts").select("id, qty").eq("item_id", itemId).eq("inv_txn_id", txnId).maybeSingle(),
      sb.from("production_receipts").select("qty").eq("inv_txn_id", txnId).limit(2000),
      sb.from("production_receipts").select("qty").eq("item_id", itemId).limit(2000),
    ]);
    if (pair.error || byTxn.error || byItem.error || !pair.data) return null;
    const sum = (rows: { qty: unknown }[] | null) => (rows ?? []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const freshLeft = Math.round(txnQty * 100) / 100 - sum(byTxn.data);
    const freshRem = requestedQty - sum(byItem.data);
    const inc = Math.max(0, Math.min(freshLeft, freshRem));
    if (inc > 0) {
      const { error } = await sb.from("production_receipts").update({ qty: (Number(pair.data.qty) || 0) + inc }).eq("id", pair.data.id);
      if (error) return null;
    }
    return { applied: inc, freshRem: Math.max(0, freshRem - inc), freshLeft: Math.max(0, freshLeft - inc) };
  } catch { return null; }
}

// 기간(신청일~생산마감일) 소급 매칭 — 소매(재고 보충) 요청 전용 (2026-09-02 대표 지시).
//  위의 이벤트 매칭은 '입고를 기록하는 순간'에만 돌아서, 요청서보다 먼저 기록된 입고나
//  '대기'였다가 나중에 완료 처리된 입고는 연결되지 않는다. 이 함수가 열린 재고 보충 요청의
//  신청일~마감일 창 안에 있는 미연결 입고를 찾아 소급 연결한다(요청 생성·수정 시 호출 —
//  조회(GET)에서는 부르지 않는다: 읽기 화면이 쓰기·알림을 만들면 안 되고 동시 조회 경합도 커진다).
//  · 도매 납품 요청은 대상 아님 — 소매→도매 이전(move)이 이벤트로 연결하는 별도 메커니즘.
//  · 이미 어떤 요청에든 연결된 수량은 제외(inv_txn_id 별 잔여만 배분) — 이중 집계 방지.
//  · 채널이동(내부 이동) 입고는 제조사 생산이 아니므로 제외. '대기' 입고 제외(완료만).
//  · 소급 연결은 건별 알림을 쏘지 않는다(과거분 일괄 연결이 알림 폭주가 되지 않게) —
//    memo '기간 자동 매칭'이 증거로 남고, 상태 전환(요청→진행중)만 기록한다.
//  실패해도 호출부(조회·생성)를 막지 않는다 — 전체를 try/catch 로 감싼 fire-safe.
export async function syncWindowReceipts(sb: SupabaseClient, opts?: { requestId?: string }): Promise<void> {
  try {
    const todayKst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

    // 1) 대상 요청 — 열린(요청·진행중) 재고 보충. purpose(082)/due_date(071) 미적용 환경 폴백은
    //    에러에 보이는 컬럼을 반복 제거(순서 의존 없음 — 둘 다 없어도 완주).
    type Head = { id: string; req_no: string | null; status: string; request_date: string; due_date?: string | null };
    const selHead = (withDue: boolean, withPurpose: boolean) => {
      let q = sb.from("production_requests")
        .select(`id, req_no, status, request_date${withDue ? ", due_date" : ""}`)
        .in("status", ["요청", "진행중"]);
      if (withPurpose) q = q.eq("purpose", "재고 보충");
      if (opts?.requestId) q = q.eq("id", opts.requestId);
      return q.order("request_date", { ascending: true }).limit(200);
    };
    let withDue = true, withPurpose = true;
    let res = await selHead(withDue, withPurpose);
    for (let guard = 0; res.error && guard < 2; guard++) {
      if (withPurpose && /purpose/i.test(res.error.message)) withPurpose = false;
      else if (withDue && /due_date/i.test(res.error.message)) withDue = false;
      else break;
      res = await selHead(withDue, withPurpose);
    }
    if (res.error || !res.data?.length) return;
    const heads = (res.data as unknown as Head[])
      .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.request_date || ""))
      .sort((a, b) => a.request_date.localeCompare(b.request_date)); // 오래된 요청부터(이벤트 매칭과 동일 FIFO)
    if (!heads.length) return;
    const windowOf = (h: Head) => ({ from: h.request_date, to: (h.due_date && /^\d{4}-\d{2}-\d{2}$/.test(h.due_date)) ? h.due_date : todayKst });

    // 2) 요청 품목 + 기존 입고 누계 → 잔여 (기본 1000행 캡에 걸리지 않게 명시 한도·청크)
    const { data: itemsRaw, error: ie } = await sb.from("production_request_items")
      .select("id, request_id, product_id, requested_qty").in("request_id", heads.map((h) => h.id)).limit(5000);
    if (ie || !itemsRaw?.length) return;
    type Item = { id: string; request_id: string; product_id: string; requested_qty: number };
    const items = itemsRaw as unknown as Item[];
    const received = new Map<string, number>();
    for (let i = 0; i < items.length; i += 100) {
      const part = items.slice(i, i + 100).map((x) => x.id);
      const { data: rcs, error: re } = await sb.from("production_receipts").select("item_id, qty").in("item_id", part).limit(5000);
      if (re) return;
      for (const rc of rcs ?? []) received.set(rc.item_id as string, (received.get(rc.item_id as string) || 0) + (Number(rc.qty) || 0));
    }
    const remaining = new Map<string, number>();
    for (const it of items) remaining.set(it.id, Math.max(0, (Number(it.requested_qty) || 0) - (received.get(it.id) || 0)));
    if (![...remaining.values()].some((v) => v > 0)) return;

    // 3) 창 안의 입고 후보 — 완료(034 폴백)·채널이동 제외·양수만. 전체 창(min~max)으로 한 번에 읽는다.
    const pids = [...new Set(items.map((i) => i.product_id))];
    const from = heads.reduce((m, h) => (windowOf(h).from < m ? windowOf(h).from : m), windowOf(heads[0]).from);
    const to = heads.reduce((m, h) => (windowOf(h).to > m ? windowOf(h).to : m), windowOf(heads[0]).to);
    const selTxn = (withStatus: boolean) => {
      let q = sb.from("inventory_txns").select("id, product_id, qty, txn_date")
        .eq("type", "입고").gt("qty", 0)
        .in("product_id", pids).gte("txn_date", from).lte("txn_date", to)
        .or("partner.is.null,partner.neq.채널이동") // neq 단독은 null partner 를 탈락시킨다
        .order("txn_date", { ascending: true }).order("id", { ascending: true }).limit(2000);
      if (withStatus) q = q.eq("status", "완료");
      return q;
    };
    let tres = await selTxn(true);
    if (tres.error && /status/i.test(tres.error.message)) tres = await selTxn(false);
    if (tres.error || !tres.data?.length) return;
    type Txn = { id: string; product_id: string; qty: number; txn_date: string };
    const txns = tres.data as unknown as Txn[];

    // 4) 이미 연결된 수량(어느 요청이든) → 원장 건별 잔여
    const allocated = new Map<string, number>();
    for (let i = 0; i < txns.length; i += 100) {
      const part = txns.slice(i, i + 100).map((t) => t.id);
      const { data: ex, error: ee } = await sb.from("production_receipts").select("inv_txn_id, qty").in("inv_txn_id", part).limit(5000);
      if (ee) return;
      for (const r of ex ?? []) {
        const k = r.inv_txn_id as string;
        if (k) allocated.set(k, (allocated.get(k) || 0) + (Number(r.qty) || 0));
      }
    }

    // 5) FIFO 배분 — 오래된 입고부터, 창이 맞는 오래된 요청부터
    const started = new Set<string>();
    for (const t of txns) {
      let left = Math.round((Number(t.qty) || 0) * 100) / 100 - (allocated.get(t.id) || 0);
      if (left <= 0) continue;
      for (const h of heads) {
        if (left <= 0) break;
        const w = windowOf(h);
        if (t.txn_date < w.from || t.txn_date > w.to) continue;
        for (const it of items) {
          if (left <= 0) break;
          if (it.request_id !== h.id || it.product_id !== t.product_id) continue;
          const rem = remaining.get(it.id) || 0;
          if (rem <= 0) continue;
          const alloc = Math.min(rem, left);
          const { error: re2, inserted } = await insertReceiptOnce(sb, {
            request_id: h.id, item_id: it.id, qty: alloc,
            memo: "기간 자동 매칭(신청일~마감일)", received_by: null,
            inv_txn_id: t.id, receipt_date: t.txn_date,
          });
          if (re2) { console.warn("[production-allocate] window receipt insert failed", re2.message); continue; }
          if (inserted) {
            remaining.set(it.id, rem - alloc);
            left -= alloc;
          } else {
            // 같은 쌍 링크가 이미 있음(이벤트 매칭 등) — 최신 DB 기준으로 증액분만 합산
            const r2 = await topUpPair(sb, it.id, it.requested_qty, t.id, Number(t.qty) || 0);
            if (!r2) continue;
            remaining.set(it.id, r2.freshRem);
            left = r2.freshLeft;
            if (r2.applied <= 0) continue; // 경합 중복 — 상대 호출이 이미 처리(상태 전환 포함)
          }
          if (h.status === "요청" && !started.has(h.id)) {
            started.add(h.id);
            const { data: flipped } = await sb.from("production_requests")
              .update({ status: "진행중", updated_at: new Date().toISOString() })
              .eq("id", h.id).eq("status", "요청").select("id");
            // 실제로 이 호출이 전환했을 때만 기록(동시 실행이 이미 전환했으면 로그 중복 방지)
            if (flipped?.length) await logProductionRequestStatusChanged(h.req_no || "", "요청", "진행중", "자동 매칭");
            h.status = "진행중";
          }
        }
      }
    }
  } catch (e) { console.warn("[production-allocate] syncWindowReceipts failed", e); }
}

// ── 소매→도매 이전의 수동 배정(2026-09-14 대표 확정) ─────────────────────────
//  자동 FIFO 대신 담당자가 '어느 도매 요청서에 얼마'를 직접 지정한다. 배정 없는 잔여는
//  기타(요청 미연결 일반 이동 — 기본값 기타 100%). 이행 100% 도달 요청은 자동 '완료'로
//  전환돼 도매 요청 종합(열린 요청 합산)에서 즉시 빠지고, 이동 취소(cascade 원복)로
//  100% 아래로 내려간 완료 요청은 자동 '진행중'으로 재개된다.

const ALLOC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ManualAlloc = { item_id: string; qty: number };

type AllocTargetRow = {
  id: string; request_id: string; requested_qty: number; product_id: string;
  head: { id: string; req_no: string | null; status: string };
};

// 배정 대상 품목행 로드 — 열린(요청·진행중) '도매 납품' 요청만.
//  purpose(082) 미적용 환경은 빈 목록 — 용도 무관 폴백을 두면 제조사(재고 보충) 요청에
//  수동 배정이 기록될 수 있다(검증 확정). targets 라우트도 같은 이유로 빈 목록을 낸다.
async function loadAllocItems(sb: SupabaseClient, itemIds: string[]): Promise<AllocTargetRow[] | null> {
  if (!itemIds.length) return [];
  const { data, error } = await sb.from("production_request_items")
    .select("id, request_id, requested_qty, product_id, production_requests!inner(id, req_no, status)")
    .in("id", itemIds)
    .in("production_requests.status", ["요청", "진행중"])
    .eq("production_requests.purpose", "도매 납품");
  if (error && /purpose/i.test(error.message)) return [];
  if (error) return null;
  return (data ?? [])
    .map((r) => {
      const rel = (r as { production_requests?: unknown }).production_requests;
      const head = (Array.isArray(rel) ? rel[0] : rel) as AllocTargetRow["head"] | null;
      return head ? {
        id: r.id as string, request_id: r.request_id as string,
        requested_qty: Number(r.requested_qty) || 0, product_id: r.product_id as string, head,
      } : null;
    })
    .filter((x): x is AllocTargetRow => !!x);
}

// 저장 전 검증 — 이동(원장) 기록보다 먼저 불러 잘못된 배정이면 이동 자체를 거부한다.
export async function validateManualAllocations(
  sb: SupabaseClient, product_id: string, allocations: ManualAlloc[],
): Promise<{ ok: boolean; error?: string }> {
  const ids = allocations.map((a) => a.item_id);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "같은 요청서에 배정이 중복 입력됐습니다." };
  const rows = await loadAllocItems(sb, ids);
  if (rows === null) return { ok: false, error: "요청서 확인에 실패했습니다. 잠시 후 다시 시도하세요." };
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const a of allocations) {
    const r = byId.get(a.item_id);
    if (!r) return { ok: false, error: "배정한 요청서가 그 사이 완료·취소됐거나 대상이 아닙니다. 새로고침 후 다시 배정하세요." };
    if (r.product_id !== product_id) return { ok: false, error: "배정한 요청서의 품목이 이동 품목과 다릅니다." };
  }
  return { ok: true };
}

// 이동 기록 후 배정 실행 — 실패는 이동을 되돌리지 않고 경고로 알린다(이동·배정 중 이동이 원장).
export async function applyManualAllocations(
  sb: SupabaseClient,
  opts: { inv_txn_id: string; product_id: string; receipt_date?: string; allocations: ManualAlloc[]; actor: string | null },
): Promise<{ warnings: string[]; requestIds: string[]; lines: string[] }> {
  const warnings: string[] = [];
  const lines: string[] = []; // 이전 알림 게시물 본문용 — 요청서별 배정·누적 요약
  const rows = await loadAllocItems(sb, opts.allocations.map((a) => a.item_id));
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  // 품목행별 기입고 합(배정 전) — 알림에 '누적/요청' 을 싣기 위한 조회. 실패해도 배정은 진행.
  const prevRecv = new Map<string, number>();
  try {
    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length) {
      const { data: rcs } = await sb.from("production_receipts").select("item_id, qty").in("item_id", ids).limit(5000);
      for (const rc of rcs ?? []) prevRecv.set(rc.item_id as string, (prevRecv.get(rc.item_id as string) || 0) + (Number(rc.qty) || 0));
    }
  } catch { /* 누적 없이 표기 */ }
  let pname = "품목";
  try {
    const { data } = await sb.from("products").select("name").eq("id", opts.product_id).maybeSingle();
    if (data?.name) pname = String(data.name);
  } catch { /* 이름 없이 진행 */ }
  const requestIds = new Set<string>();
  for (const a of opts.allocations) {
    const r = byId.get(a.item_id);
    if (!r) { warnings.push("요청서 하나가 그 사이 닫혀 배정을 건너뛰었습니다(해당 수량은 기타로 남음)."); continue; }
    const row: Record<string, unknown> = {
      request_id: r.request_id, item_id: a.item_id, qty: a.qty,
      memo: "소매→도매 이전 배정", received_by: opts.actor, inv_txn_id: opts.inv_txn_id,
    };
    if (opts.receipt_date && ALLOC_DATE_RE.test(opts.receipt_date)) row.receipt_date = opts.receipt_date;
    const { error, inserted } = await insertReceiptOnce(sb, row);
    if (error || !inserted) { warnings.push(`${r.head.req_no || "요청서"} 배정 기록 실패${error ? `: ${error.message}` : ""}`); continue; }
    requestIds.add(r.request_id);
    const cum = (prevRecv.get(a.item_id) || 0) + a.qty;
    const cumStr = ` — 누적 ${cum.toLocaleString()}/${r.requested_qty.toLocaleString()}${r.requested_qty > 0 ? ` (${Math.round((cum / r.requested_qty) * 100)}%)` : ""}`;
    lines.push(`- ${r.head.req_no || "요청서"} 배정 ×${a.qty.toLocaleString()}${cumStr}`);
    await logProductionReceipt(r.head.req_no || "", pname, a.qty, opts.actor, `이번 배정 ×${a.qty.toLocaleString()}${cumStr}`);
    // 상태 전환(요청→진행중/완료)은 recheckRequestCompletion 한 곳에서만 — 여기서도 전환하면
    //  100% 배정 시 '요청→진행중→완료' 이중 전환·이중 알림이 난다(검증 확정).
  }
  return { warnings, requestIds: [...requestIds], lines };
}

// 요청 이행 현황 판독 — '도매 납품' 요청만 대상(제조사 요청은 이 자동 전환 체계 밖 — 검증 확정).
//  완료 판정은 합계가 아니라 '모든 품목이 각자 100% 이상' — 한 품목 과배정이 다른 품목의
//  미이행을 가리지 않게 한다(검증 확정). purpose 미적용 환경·조회 실패·절삭 위험은 null(판정 보류).
export async function getRequestFullness(
  sb: SupabaseClient, requestId: string,
): Promise<{ full: boolean; status: string; req_no: string; requested: number; received: number } | null> {
  try {
    const { data: head, error: he } = await sb.from("production_requests")
      .select("id, req_no, status, purpose").eq("id", requestId).maybeSingle();
    if (he || !head) return null; // purpose 컬럼 없음(082 미적용) 포함 — 자동 전환 없이 보류
    if (head.purpose !== "도매 납품") return null;
    const { data: items, error: ie } = await sb.from("production_request_items")
      .select("id, requested_qty").eq("request_id", requestId).limit(2000);
    if (ie || !items?.length) return null;
    const recvByItem = new Map<string, number>();
    for (let i = 0; i < items.length; i += 100) {
      const part = items.slice(i, i + 100).map((x) => x.id as string);
      const { data: rcs, error: re } = await sb.from("production_receipts")
        .select("item_id, qty").in("item_id", part).limit(5000);
      if (re) return null;
      if ((rcs ?? []).length >= 5000) return null; // 절삭 위험 — 과소 합산으로 오판하지 않게 보류
      for (const r of rcs ?? []) {
        const k = r.item_id as string;
        recvByItem.set(k, (recvByItem.get(k) || 0) + (Number(r.qty) || 0));
      }
    }
    const full = items.every((it) => (recvByItem.get(it.id as string) || 0) >= (Number(it.requested_qty) || 0) - 0.001);
    const requested = items.reduce((s, it) => s + (Number(it.requested_qty) || 0), 0);
    const received = [...recvByItem.values()].reduce((s, v) => s + v, 0);
    return { full, status: String(head.status), req_no: (head.req_no as string) || "", requested, received };
  } catch { return null; }
}

// 이행률 재판정 — 상태 전환의 단일 창구.
//  · mode "complete"(배정 직후): 전 품목 100% 이상이면 자동 '완료', 아니면 '요청'을 '진행중'으로만.
//  · mode "reopen"(이동 취소 직후): 100% 아래로 내려간 '완료'를 '진행중'으로 재개 — 호출부(DELETE)가
//    '삭제 전에 100%였던 요청'만 넘겨야 한다. 사람이 이행 미달인 채 수동 완료한 요청을 되살리면
//    안 되기 때문(검증 확정 — 자동 완료 원복만 허용).
//  실패해도 호출부를 막지 않는다.
export async function recheckRequestCompletion(
  sb: SupabaseClient, requestIds: string[], reason: string, mode: "complete" | "reopen" = "complete",
): Promise<void> {
  for (const id of [...new Set(requestIds)]) {
    try {
      const f = await getRequestFullness(sb, id);
      if (!f) continue;
      const pctv = f.requested > 0 ? Math.round((f.received / f.requested) * 100) : 0;
      const detail = `이행 ${f.received.toLocaleString()}/${f.requested.toLocaleString()} (${pctv}%)`; // 게시물 본문용
      if (mode === "complete") {
        if (f.full && (f.status === "요청" || f.status === "진행중")) {
          const { data: flipped } = await sb.from("production_requests")
            .update({ status: "완료", updated_at: new Date().toISOString() })
            .eq("id", id).in("status", ["요청", "진행중"]).select("id");
          if (flipped?.length) await logProductionRequestStatusChanged(f.req_no, f.status, "완료", `${reason} — 이행 100%`, detail);
        } else if (!f.full && f.status === "요청") {
          const { data: flipped } = await sb.from("production_requests")
            .update({ status: "진행중", updated_at: new Date().toISOString() })
            .eq("id", id).eq("status", "요청").select("id");
          if (flipped?.length) await logProductionRequestStatusChanged(f.req_no, "요청", "진행중", reason, detail);
        }
      } else if (!f.full && f.status === "완료") {
        const { data: flipped } = await sb.from("production_requests")
          .update({ status: "진행중", updated_at: new Date().toISOString() })
          .eq("id", id).eq("status", "완료").select("id");
        if (flipped?.length) await logProductionRequestStatusChanged(f.req_no, "완료", "진행중", reason, detail);
      }
    } catch (e) { console.warn("[production-allocate] recheck failed", e); }
  }
}

// 이행 규칙(2026-07-29 확정 · 2026-09-14 도매편 개정):
//  · 입고(도소매 무관)          → '재고 보충'(제조사 요청) 이행 — 제조사가 만들어 보냈는가
//  · 소매→도매 이전(도매 입고편) → '도매 납품'(도매 요청) 이행 — 담당자가 이전 시 요청서별 수동 배정
export async function allocateReceiptsToOpenRequests(
  sb: SupabaseClient,
  entries: AllocEntry[],
  actor: string | null,
  opts?: { purpose?: "재고 보충" | "도매 납품"; memo?: string },
): Promise<void> {
  const positive = entries.filter((e) => e.inv_txn_id && e.product_id && Math.round(e.qty * 100) / 100 > 0);
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
      .select("id, request_id, requested_qty, product_id, production_requests!inner(id, req_no, status, request_date, due_date, created_at)")
      .in("product_id", pids)
      .in("production_requests.status", ["요청", "진행중"]);
    if (withPurpose && opts?.purpose) q = q.eq("production_requests.purpose", opts.purpose);
    return q;
  };
  let { data: itemsRaw, error: ie } = await query(true);
  if (ie && /purpose/i.test(ie.message)) ({ data: itemsRaw, error: ie } = await query(false)); // 082 미적용 폴백
  if (ie || !itemsRaw?.length) return;

  type Head = { id: string; req_no: string | null; status: string; request_date: string; due_date: string | null; created_at: string };
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

  // 원장 건별 기배분 합 — 재전환(완료→대기→완료)·중복 호출에서 같은 입고가 다른 요청에
  //  또 배분되지 않게 잔여에서 뺀다. 조회 실패 시엔 기존 동작(차감 없음)으로 진행.
  const priorByTxn = new Map<string, number>();
  try {
    const ids = positive.map((e) => e.inv_txn_id);
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb.from("production_receipts").select("inv_txn_id, qty").in("inv_txn_id", ids.slice(i, i + 100)).limit(5000);
      for (const r of data ?? []) {
        const k = r.inv_txn_id as string | null;
        if (k) priorByTxn.set(k, (priorByTxn.get(k) || 0) + (Number(r.qty) || 0));
      }
    }
  } catch { /* 폴백: 차감 없이 진행 */ }

  const startedRequests = new Set<string>(); // 이번 호출에서 요청→진행중 전환한 요청(중복 전환 방지)

  for (const e of positive) {
    let left = Math.round(e.qty * 100) / 100 - (priorByTxn.get(e.inv_txn_id) || 0);
    // 요청일 기준 매칭(대표 확정): 입고일이 요청일~마감일 창 안에 드는 요청서를 우선 배분한다.
    //  창에 드는 요청이 없으면 기존 FIFO(오래된 요청부터) — 마감을 넘겨 도착한 지연 납품도 붙게 유지.
    const inWindow = (it: OpenItem) =>
      !!e.receipt_date &&
      it.head.request_date <= e.receipt_date &&
      (!it.head.due_date || e.receipt_date <= it.head.due_date);
    const ordered = e.receipt_date
      ? [...items].sort((a, b) =>
          Number(inWindow(b)) - Number(inWindow(a)) ||
          a.head.request_date.localeCompare(b.head.request_date) ||
          a.head.created_at.localeCompare(b.head.created_at)
        )
      : items;
    for (const it of ordered) {
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
      const { error: re, inserted } = await insertReceiptOnce(sb, row);
      if (re) { console.warn("[production-allocate] receipt insert failed", re.message); continue; }

      remaining.set(it.id, rem - alloc);
      left -= alloc;

      const reqNo = it.head.req_no || "";
      // 경합으로 무시된 중복(inserted=false)엔 알림 생략 — 행은 상대 호출이 이미 만들었다
      if (inserted) await logProductionReceipt(reqNo, nameById.get(e.product_id) || "품목", alloc, actor);
      if (it.head.status === "요청" && !startedRequests.has(it.request_id)) {
        startedRequests.add(it.request_id);
        const { data: flipped } = await sb.from("production_requests")
          .update({ status: "진행중", updated_at: new Date().toISOString() })
          .eq("id", it.request_id).eq("status", "요청").select("id");
        if (flipped?.length) await logProductionRequestStatusChanged(reqNo, "요청", "진행중", actor);
        it.head.status = "진행중";
      }
    }
  }
}
