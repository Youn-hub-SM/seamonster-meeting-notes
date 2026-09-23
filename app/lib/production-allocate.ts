import type { SupabaseClient } from "@supabase/supabase-js";
import { logProductionReceipt, logProductionRequestStatusChanged } from "./b2b-activity";
import { UNREQUESTED_ITEM_MEMO, isFactoryPurpose, PURPOSE_CHANNEL, type PrPurpose } from "./wholesale-production";

// 입고 → 생산 요청 연결(지정 매칭, 2026-09-23 대표 확정) — 입고를 기록하는 사람이 요청서를 고른다.
//  화면이 거래일 기준으로 생산기간(생산시작일~생산종료일)에 드는 열린 제조사 요청서를 기본 선택해 두고,
//  사람이 바꾸거나 '연결 안 함'(행사·대량 협의분, 일반 입고)을 고른다. 시스템이 창·잔여로 추측해 붙이던
//  자동 매칭(창 규칙·소급 매칭)은 폐지 — 무관한 입고가 요청서에 전량 잡히던 사고의 근원이었다.
//  연결 규칙: 고른 요청서의 그 품목 줄에 전량(요청 수량을 넘겨도 '초과'로 기록). 요청서에 없던 품목은
//  '[요청서에 없음]' 줄(요청수량 0)에 기록. 모든 품목이 100% 이상이면 요청서를 자동 완료(마감)한다.
//  수량은 소수 둘째 자리까지(104 — 요청·입고 모두 numeric).
//
//  취소 정합성: receipts.inv_txn_id 가 원장에 cascade(083) — 입고/출고에서 그 입고를 취소
//  (원장 삭제)하면 증거도 함께 지워지고, 호출부가 recheckRequestCompletion(reopen)으로 완료를 되돌린다.
//
//  실패해도 입고 자체를 막지 않는다 — 호출부는 try/catch 로 감싸 결과만 응답에 싣는다.

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


// ── 소매→도매 이전의 수동 배정(2026-09-14 대표 확정) ─────────────────────────
//  자동 FIFO 대신 담당자가 '어느 도매 요청서에 얼마'를 직접 지정한다. 배정 없는 잔여는
//  기타(요청 미연결 일반 이동 — 기본값 기타 100%). 이행 100% 도달 요청은 자동 '완료'로
//  전환돼 도매 요청 종합(열린 요청 합산)에서 즉시 빠지고, 이동 취소(cascade 원복)로
//  100% 아래로 내려간 완료 요청은 자동 '진행중'으로 재개된다.

const ALLOC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ManualAlloc = { item_id: string; qty: number };
// 수동 배정 대상 용도 — 소매→도매='도매 납품' · 소매→프로모션='프로모션'(113) · 소매→도매 대량='도매 대량'(115).
//  = 제조사(재고 보충)를 뺀 전부. PR_PURPOSES 에 용도가 늘면 여기가 자동으로 따라오고, 제조사 요청에
//  수동 배정이 기록되는 길은 계속 막혀 있다(PURPOSE_CHANNEL 의 키 집합과 정확히 같다).
export type AllocPurpose = Exclude<PrPurpose, "재고 보충">;

type AllocTargetRow = {
  id: string; request_id: string; requested_qty: number; product_id: string;
  head: { id: string; req_no: string | null; status: string };
};

// 배정 대상 품목행 로드 — 열린(요청·진행중) '도매 납품' 요청만.
//  purpose(082) 미적용 환경은 빈 목록 — 용도 무관 폴백을 두면 제조사(재고 보충) 요청에
//  수동 배정이 기록될 수 있다(검증 확정). targets 라우트도 같은 이유로 빈 목록을 낸다.
async function loadAllocItems(sb: SupabaseClient, itemIds: string[], purpose: AllocPurpose): Promise<AllocTargetRow[] | null> {
  if (!itemIds.length) return [];
  const { data, error } = await sb.from("production_request_items")
    .select("id, request_id, requested_qty, product_id, production_requests!inner(id, req_no, status)")
    .in("id", itemIds)
    .in("production_requests.status", ["요청", "진행중"])
    .eq("production_requests.purpose", purpose);
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
  sb: SupabaseClient, product_id: string, allocations: ManualAlloc[], purpose: AllocPurpose = "도매 납품",
): Promise<{ ok: boolean; error?: string }> {
  const ids = allocations.map((a) => a.item_id);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "같은 요청서에 배정이 중복 입력됐습니다." };
  const rows = await loadAllocItems(sb, ids, purpose);
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
  opts: { inv_txn_id: string; product_id: string; receipt_date?: string; allocations: ManualAlloc[]; actor: string | null; purpose?: AllocPurpose },
): Promise<{ warnings: string[]; requestIds: string[]; lines: string[] }> {
  const warnings: string[] = [];
  const lines: string[] = []; // 이전 알림 게시물 본문용 — 요청서별 배정·누적 요약
  const rows = await loadAllocItems(sb, opts.allocations.map((a) => a.item_id), opts.purpose ?? "도매 납품");
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
      memo: `소매→${PURPOSE_CHANNEL[opts.purpose ?? "도매 납품"] ?? "도매"} 이전 배정`, received_by: opts.actor, inv_txn_id: opts.inv_txn_id,
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

// 요청 이행 현황 판독 — 모든 용도(제조사는 입고 연결, 나머지는 수동 배정). 2026-09-23 지정 매칭과 함께 제조사도 자동 완료·재개 대상.
//  완료 판정은 합계가 아니라 '모든 품목이 각자 100% 이상' — 한 품목 과배정이 다른 품목의
//  미이행을 가리지 않게 한다(검증 확정). purpose 미적용 환경·조회 실패·절삭 위험은 null(판정 보류).
export async function getRequestFullness(
  sb: SupabaseClient, requestId: string,
): Promise<{ full: boolean; status: string; req_no: string; requested: number; received: number } | null> {
  try {
    const { data: head, error: he } = await sb.from("production_requests")
      .select("id, req_no, status, purpose").eq("id", requestId).maybeSingle();
    if (he || !head) return null; // purpose 컬럼 없음(082 미적용) 포함 — 자동 전환 없이 보류

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


// ── 입고 → 지정 요청서 연결 ─────────────────────────────────────────────────
export const LINK_MEMO = "입고 연결(지정)";

export type LinkResult = {
  ok: boolean;
  reason?: string;                 // ok=false 사유(화면 배너용)
  req_no?: string;
  status?: string;                 // 연결 후 요청서 상태(완료로 닫혔으면 '완료')
  lines: { product_id: string; qty: number; over: number; unrequested: boolean }[]; // over = 요청 초과분
};

// 입고 원장 행들을 사람이 고른 제조사(재고 보충) 요청서에 연결한다.
//  · 열린(요청·진행중) 제조사 요청서만. 완료·취소·확정형이면 연결하지 않고 reason 을 돌려준다.
//  · 품목 줄이 있으면 그 줄에 전량(초과 허용), 없으면 '[요청서에 없음]' 줄 생성(묶음 제외).
//  · 같은 (item, txn) 쌍이 이미 있으면(재호출) 증액분만(topUpPair) — 이중 집계 없음.
//  · 연결 뒤 요청 → 진행중, 전 품목 100% 이상이면 자동 완료(마감).
export async function allocateReceiptsToRequest(
  sb: SupabaseClient, requestId: string, entries: AllocEntry[], actor: string | null,
): Promise<LinkResult> {
  const positive = entries.filter((e) => e.inv_txn_id && e.product_id && Math.round(e.qty * 100) / 100 > 0);
  if (!positive.length) return { ok: true, lines: [] };

  // 요청서 확인 — purpose(082) 미적용이면 전부 제조사로 본다
  type Head = { id: string; req_no: string | null; status: string; purpose?: string | null };
  let head: Head | null = null;
  {
    let r = await sb.from("production_requests").select("id, req_no, status, purpose").eq("id", requestId).maybeSingle();
    if (r.error && /purpose/i.test(r.error.message)) r = await sb.from("production_requests").select("id, req_no, status").eq("id", requestId).maybeSingle();
    if (r.error || !r.data) return { ok: false, reason: "요청서를 찾을 수 없습니다.", lines: [] };
    head = r.data as unknown as Head;
  }
  const reqNo = head.req_no || "";
  if (!isFactoryPurpose(head.purpose)) return { ok: false, reason: `${reqNo} 은 제조사 요청서가 아닙니다.`, req_no: reqNo, lines: [] };
  if (head.status !== "요청" && head.status !== "진행중") return { ok: false, reason: `${reqNo} 은 ${head.status} 상태입니다 — 열린 요청서에만 연결됩니다.`, req_no: reqNo, status: head.status, lines: [] };

  type Item = { id: string; product_id: string; requested_qty: number; memo: string | null };
  const { data: itemsRaw, error: ie } = await sb.from("production_request_items")
    .select("id, product_id, requested_qty, memo").eq("request_id", requestId).limit(2000);
  if (ie) return { ok: false, reason: "요청 품목을 읽지 못했습니다.", req_no: reqNo, lines: [] };
  const items = (itemsRaw ?? []) as Item[];

  // 기존 입고 누계(초과분 계산용) + 원장 건별 기배분(재호출 멱등)
  const received = new Map<string, number>();
  const priorByTxn = new Map<string, number>();
  if (items.length) {
    const { data: rcs } = await sb.from("production_receipts").select("item_id, inv_txn_id, qty").in("item_id", items.map((i) => i.id)).limit(5000);
    for (const rc of rcs ?? []) {
      received.set(rc.item_id as string, (received.get(rc.item_id as string) || 0) + (Number(rc.qty) || 0));
      if (rc.inv_txn_id) priorByTxn.set(rc.inv_txn_id as string, (priorByTxn.get(rc.inv_txn_id as string) || 0) + (Number(rc.qty) || 0));
    }
  }
  const pids = [...new Set(positive.map((e) => e.product_id))];
  const nameById = new Map<string, string>();
  const bundleParents = new Set<string>();
  try {
    const [{ data: ps }, { data: bs }] = await Promise.all([
      sb.from("products").select("id, name").in("id", pids),
      sb.from("product_bundles").select("parent_id").in("parent_id", pids),
    ]);
    for (const p of ps ?? []) nameById.set(p.id as string, p.name as string);
    for (const b of bs ?? []) bundleParents.add(b.parent_id as string);
  } catch { /* 이름·묶음 없이 진행 */ }

  const ensureUnrequestedLine = async (product_id: string): Promise<Item | null> => {
    const exists = items.find((it) => it.product_id === product_id && it.requested_qty <= 0);
    if (exists) return exists;
    let id: string | null = null;
    const ins = await sb.from("production_request_items")
      .insert({ request_id: requestId, product_id, requested_qty: 0, memo: UNREQUESTED_ITEM_MEMO, sort: 9000 })
      .select("id").single();
    if (!ins.error && ins.data) id = ins.data.id as string;
    else if (ins.error && (ins.error.code === "23505" || /duplicate key/i.test(ins.error.message))) {
      const { data: ex } = await sb.from("production_request_items").select("id")
        .eq("request_id", requestId).eq("product_id", product_id).eq("requested_qty", 0).eq("memo", UNREQUESTED_ITEM_MEMO).limit(1);
      id = (ex?.[0]?.id as string | undefined) ?? null;
    }
    if (!id) { console.warn("[production-allocate] unrequested line insert failed", ins.error?.message); return null; }
    const line: Item = { id, product_id, requested_qty: 0, memo: UNREQUESTED_ITEM_MEMO };
    items.push(line);
    return line;
  };

  const out: LinkResult = { ok: true, req_no: reqNo, status: head.status, lines: [] };
  for (const e of positive) {
    const qty = Math.round(e.qty * 100) / 100;
    const left = qty - (priorByTxn.get(e.inv_txn_id) || 0);
    if (left <= 0) continue; // 이미 이 원장이 연결됨(재호출)
    const real = items.find((it) => it.product_id === e.product_id && it.requested_qty > 0);
    let it: Item | null = real ?? null;
    if (!it) {
      if (bundleParents.has(e.product_id)) continue; // 묶음은 요청서에 못 담는다 — 연결 없는 일반 입고
      it = await ensureUnrequestedLine(e.product_id);
      if (!it) continue;
    }
    const row: Record<string, unknown> = {
      request_id: requestId, item_id: it.id, qty: left, memo: LINK_MEMO, received_by: actor, inv_txn_id: e.inv_txn_id,
    };
    if (e.receipt_date && /^\d{4}-\d{2}-\d{2}$/.test(e.receipt_date)) row.receipt_date = e.receipt_date;
    const { error: re, inserted } = await insertReceiptOnce(sb, row);
    if (re) { console.warn("[production-allocate] link insert failed", re.message); continue; }
    let applied = left;
    if (!inserted) { const r2 = await topUpPair(sb, it.id, Number.POSITIVE_INFINITY, e.inv_txn_id, qty); applied = r2?.applied ?? 0; }
    if (applied <= 0) continue;
    const before = received.get(it.id) || 0;
    received.set(it.id, before + applied);
    const over = it.requested_qty > 0 ? Math.min(applied, Math.max(0, Math.round((before + applied - it.requested_qty) * 100) / 100)) : 0;
    out.lines.push({ product_id: e.product_id, qty: applied, over, unrequested: it.requested_qty <= 0 });
    await logProductionReceipt(reqNo, nameById.get(e.product_id) || "품목", applied, actor, it.requested_qty <= 0 ? `${UNREQUESTED_ITEM_MEMO} ${LINK_MEMO}` : LINK_MEMO);
  }
  // 상태 전환은 recheckRequestCompletion 한 곳에서 — 요청→진행중(부분) 또는 →완료(전 품목 100%↑, 도매 요청서와 같은 규칙)
  if (out.lines.length) {
    await recheckRequestCompletion(sb, [requestId], "입고 기록");
    try {
      const { data: after } = await sb.from("production_requests").select("status").eq("id", requestId).maybeSingle();
      if (after?.status) out.status = String(after.status);
    } catch { /* 상태 모름 — 화면은 목록 재조회 */ }
  }
  return out;
}

// 입고 원장 취소(삭제) 전에 부르는 준비 — 그 원장에 연결된 요청서 중 '지금 100% 완료' 인 것만 돌려준다.
//  삭제(cascade) 뒤 recheckRequestCompletion(..., "reopen") 에 넘기면 100% 아래로 내려간 완료만 재개되고,
//  사람이 미달인 채 마감한 요청서는 되살아나지 않는다(수동 완료 보존 규칙).
//  조회 실패는 null — 호출부가 취소를 중단한다(삼키면 100% 아래인데 '완료'로 굳는다). 판정 보류(getRequestFullness null)는 건너뛴다.
export async function fullRequestsOfTxns(sb: SupabaseClient, txnIds: string[]): Promise<string[] | null> {
  const ids = txnIds.filter(Boolean);
  if (!ids.length) return [];
  try {
    const reqIds = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("production_receipts").select("request_id").in("inv_txn_id", ids.slice(i, i + 100)).limit(5000);
      if (error) return null;
      for (const r of data ?? []) if (r.request_id) reqIds.add(String(r.request_id));
    }
    const out: string[] = [];
    for (const rid of reqIds) {
      const f = await getRequestFullness(sb, rid);
      if (f?.full && f.status === "완료") out.push(rid);
    }
    return out;
  } catch { return null; }
}
