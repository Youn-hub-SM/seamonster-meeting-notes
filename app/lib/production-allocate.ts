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

// 이행 규칙(2026-07-29 확정):
//  · 입고(도소매 무관)          → '재고 보충'(제조사 요청) 이행 — 제조사가 만들어 보냈는가
//  · 소매→도매 이전(도매 입고편) → '도매 납품'(도매 요청) 이행 — 생산 담당자가 도매로 옮겼는가
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
