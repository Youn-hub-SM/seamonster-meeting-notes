import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { logProductionReceipt, logProductionRequestStatusChanged } from "./b2b-activity";
import { UNREQUESTED_ITEM_MEMO, isFactoryPurpose, PURPOSE_CHANNEL, type PrPurpose } from "./wholesale-production";

// 알림(활동 기록 + 팀즈)은 응답 뒤로 — 저장 경로가 팀즈 지연을 품목 수만큼 기다리다 함수 시간 제한에 걸려
//  '원장은 저장, 연결은 일부만' 으로 끊기던 것(2026-10-11 원장 점검 S2)을 막는다. 요청 컨텍스트 밖이면 바로 보낸다.
export function deferNotify(fn: () => Promise<void>): void {
  const run = async () => { try { await fn(); } catch (e) { console.warn("[production-allocate] 알림 실패", e); } };
  try { after(run); } catch { void run(); }
}

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
): Promise<{ warnings: string[]; requestIds: string[]; lines: string[]; applied: number }> {
  const warnings: string[] = [];
  const lines: string[] = []; // 이전 알림 게시물 본문용 — 요청서별 배정·누적 요약
  let applied = 0; // 실제로 기록된 배정 수량(건너뛴 배정 제외)
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
  const notes: { reqNo: string; qty: number; detail: string }[] = []; // 요청서별 알림 — 루프 안에서 기다리지 않고 응답 뒤에 보낸다
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
    applied += a.qty;
    const cum = (prevRecv.get(a.item_id) || 0) + a.qty;
    const cumStr = ` — 누적 ${cum.toLocaleString()}/${r.requested_qty.toLocaleString()}${r.requested_qty > 0 ? ` (${Math.round((cum / r.requested_qty) * 100)}%)` : ""}`;
    lines.push(`- ${r.head.req_no || "요청서"} 배정 ×${a.qty.toLocaleString()}${cumStr}`);
    notes.push({ reqNo: r.head.req_no || "", qty: a.qty, detail: `이번 배정 ×${a.qty.toLocaleString()}${cumStr}` });
    // 상태 전환(요청→진행중/완료)은 recheckRequestCompletion 한 곳에서만 — 여기서도 전환하면
    //  100% 배정 시 '요청→진행중→완료' 이중 전환·이중 알림이 난다(검증 확정).
  }
  if (notes.length) deferNotify(async () => { for (const n of notes) await logProductionReceipt(n.reqNo, pname, n.qty, opts.actor, n.detail); });
  return { warnings, requestIds: [...requestIds], lines, applied: Math.round(applied * 100) / 100 };
}

// 요청 이행 현황 판독 — 모든 용도(제조사는 입고 연결, 나머지는 수동 배정). 2026-09-23 지정 매칭과 함께 제조사도 자동 완료·재개 대상.
//  완료 판정은 합계가 아니라 '모든 품목이 각자 100% 이상' — 한 품목 과배정이 다른 품목의
//  미이행을 가리지 않게 한다(검증 확정). purpose 미적용 환경·조회 실패·절삭 위험은 null(판정 보류).
export async function getRequestFullness(
  sb: SupabaseClient, requestId: string,
): Promise<{ full: boolean; status: string; req_no: string; requested: number; received: number; purpose: string } | null> {
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
      // range 페이징 전량 — 서버 Max Rows(1000)가 .limit 보다 우선해 조용히 잘린다(과소 합산 → full 오판·재개 누락)
      for (let off = 0; ; off += 1000) {
        const { data: rcs, error: re } = await sb.from("production_receipts")
          .select("item_id, qty").in("item_id", part).order("id", { ascending: true }).range(off, off + 999);
        if (re) return null;
        for (const r of rcs ?? []) {
          const k = r.item_id as string;
          recvByItem.set(k, (recvByItem.get(k) || 0) + (Number(r.qty) || 0));
        }
        if ((rcs ?? []).length < 1000) break;
      }
    }
    const full = items.every((it) => (recvByItem.get(it.id as string) || 0) >= (Number(it.requested_qty) || 0) - 0.001);
    const requested = items.reduce((s, it) => s + (Number(it.requested_qty) || 0), 0);
    // 알림 수치는 요청 줄만 합산(목록 total_received 와 같은 기준) — '[요청서에 없음]' 줄까지 더하면 100% 를 넘게 찍힌다
    const received = items.filter((it) => (Number(it.requested_qty) || 0) > 0).reduce((s, it) => s + (recvByItem.get(it.id as string) || 0), 0);
    return { full, status: String(head.status), req_no: (head.req_no as string) || "", requested, received, purpose: String(head.purpose || "") };
  } catch { return null; }
}

// 이행률 재판정 — 상태 전환의 단일 창구.
//  · mode "complete"(배정 직후): 전 품목 100% 이상이면 자동 '완료', 아니면 '요청'을 '진행중'으로만.
//  · mode "reopen"(이동 취소 직후): 100% 아래로 내려간 '완료'를 '진행중'으로 재개 — 호출부(DELETE)가
//    '삭제 전에 100%였던 요청'만 넘겨야 한다. 사람이 이행 미달인 채 수동 완료한 요청을 되살리면
//    안 되기 때문(검증 확정 — 자동 완료 원복만 허용).
//  · 프로모션은 완료·재개 전환을 하지 않는다(2026-10-06) — 완료는 사람의 '마감'뿐이고 마감 = 소매 합류다.
//    배정 100% 로 자동 완료되면 '마감'을 누를 길이 없어 확보분이 프로모션 칸에 갇힌다. 요청→진행중만 한다.
//  실패해도 호출부를 막지 않는다. 상태 변경 알림은 응답 뒤에(deferNotify) — 저장 경로가 팀즈를 기다리지 않게.
export async function recheckRequestCompletion(
  sb: SupabaseClient, requestIds: string[], reason: string, mode: "complete" | "reopen" = "complete",
): Promise<void> {
  for (const id of [...new Set(requestIds)]) {
    try {
      const f = await getRequestFullness(sb, id);
      if (!f) continue;
      const pctv = f.requested > 0 ? Math.round((f.received / f.requested) * 100) : 0;
      const detail = `이행 ${f.received.toLocaleString()}/${f.requested.toLocaleString()} (${pctv}%)`; // 게시물 본문용
      const promo = f.purpose === "프로모션";
      if (mode === "complete") {
        if (promo) {
          if (f.status === "요청") {
            const { data: flipped } = await sb.from("production_requests")
              .update({ status: "진행중", updated_at: new Date().toISOString() })
              .eq("id", id).eq("status", "요청").select("id");
            if (flipped?.length) deferNotify(() => logProductionRequestStatusChanged(f.req_no, "요청", "진행중", reason, detail));
          }
        } else if (f.full && (f.status === "요청" || f.status === "진행중")) {
          const { data: flipped } = await sb.from("production_requests")
            .update({ status: "완료", updated_at: new Date().toISOString() })
            .eq("id", id).in("status", ["요청", "진행중"]).select("id");
          if (flipped?.length) deferNotify(() => logProductionRequestStatusChanged(f.req_no, f.status, "완료", `${reason} — 이행 100%`, detail));
        } else if (!f.full && f.status === "요청") {
          const { data: flipped } = await sb.from("production_requests")
            .update({ status: "진행중", updated_at: new Date().toISOString() })
            .eq("id", id).eq("status", "요청").select("id");
          if (flipped?.length) deferNotify(() => logProductionRequestStatusChanged(f.req_no, "요청", "진행중", reason, detail));
        }
      } else if (!promo && !f.full && f.status === "완료") {
        const { data: flipped } = await sb.from("production_requests")
          .update({ status: "진행중", updated_at: new Date().toISOString() })
          .eq("id", id).eq("status", "완료").select("id");
        if (flipped?.length) deferNotify(() => logProductionRequestStatusChanged(f.req_no, "완료", "진행중", reason, detail));
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
  failed?: { product_id: string; qty: number; reason: string }[]; // 연결 실패 품목(입고 원장은 저장됨 — 원장은 지우지 말고 생산 요청 화면 [입고 연결]로 다시 연결, S11)
};

// 원장 건별로 이미 연결된 양 — 모든 요청서에 걸쳐(inv_txn_id 기준) 본다. 대상 요청서 품목만 보면 A 에 붙은 입고를
//  B 에 또 붙여 이행이 두 번 잡힌다(재연결 API·재시도 공용). 100개씩 청크 + range 페이징 전량. 오류는 null(연결 보류).
export async function linkedQtyByTxn(sb: SupabaseClient, txnIds: string[]): Promise<Map<string, { qty: number; requestIds: Set<string> }> | null> {
  const out = new Map<string, { qty: number; requestIds: Set<string> }>();
  const ids = [...new Set(txnIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("production_receipts").select("inv_txn_id, request_id, qty")
        .in("inv_txn_id", part).order("id", { ascending: true }).range(off, off + 999);
      if (error) return null;
      for (const r of data ?? []) {
        const k = String(r.inv_txn_id);
        const cur = out.get(k) ?? { qty: 0, requestIds: new Set<string>() };
        cur.qty = Math.round((cur.qty + (Number(r.qty) || 0)) * 100) / 100;
        if (r.request_id) cur.requestIds.add(String(r.request_id));
        out.set(k, cur);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  return out;
}

// 입고 원장 행들을 사람이 고른 제조사(재고 보충) 요청서에 연결한다.
//  · 열린(요청·진행중) 제조사 요청서만. 완료·취소·확정형이면 연결하지 않고 reason 을 돌려준다.
//  · 품목 줄이 있으면 그 줄에 전량(초과 허용), 없으면 '[요청서에 없음]' 줄 생성(묶음 제외).
//  · 정확히 한 번(S2) — 원장 건별 기연결을 모든 요청서에 걸쳐 읽어(linkedQtyByTxn) 남은 양만 붙인다. 다시 불러도
//    (재시도·재연결) 이중 집계가 없다. 기연결 조회가 실패하면 아무것도 붙이지 않는다(모르고 또 붙이지 않게).
//  · 연결 행은 한 번의 배열 upsert(102 유니크 충돌 무시) — 전부 들어가거나 전혀 안 들어간다. 줄마다 기다리지 않는다.
//    충돌로 빠진 쌍(같은 품목 줄·같은 원장에 이미 일부 연결)만 증액분을 따로 맞춘다(topUpPair).
//  · 알림은 요청서당 한 건으로 묶어 응답 뒤에(deferNotify) — 줄마다 팀즈를 기다리면 함수 시간 제한에 걸려 일부만 연결된다.
//  · 연결 뒤 요청 → 진행중, 전 품목 100% 이상이면 자동 완료(마감).
export async function allocateReceiptsToRequest(
  sb: SupabaseClient, requestId: string, entries: AllocEntry[], actor: string | null,
): Promise<LinkResult> {
  const seen = new Set<string>();
  const positive = entries.filter((e) => {
    if (!e.inv_txn_id || !e.product_id || !(Math.round(e.qty * 100) / 100 > 0) || seen.has(e.inv_txn_id)) return false;
    seen.add(e.inv_txn_id);
    return true;
  });
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

  // 원장 건별 기연결(전 요청서) — 실패면 보류(failed 로 알려 '다시 연결'로 잇게 한다)
  const prior = await linkedQtyByTxn(sb, positive.map((e) => e.inv_txn_id));
  if (!prior) return {
    ok: false, reason: "기존 연결을 확인하지 못해 연결하지 않았습니다 — 생산 요청 화면의 [입고 연결]로 다시 연결하세요.", req_no: reqNo, lines: [],
    failed: positive.map((e) => ({ product_id: e.product_id, qty: Math.round(e.qty * 100) / 100, reason: "기존 연결 확인 실패" })),
  };
  // 품목 줄별 기존 입고 누계 — 초과분 표시용(조회 실패는 초과 표시만 빠진다)
  const received = new Map<string, number>();
  for (let i = 0; i < items.length; i += 100) {
    const part = items.slice(i, i + 100).map((x) => x.id);
    for (let off = 0; ; off += 1000) {
      const { data: rcs, error } = await sb.from("production_receipts").select("item_id, qty").in("item_id", part).order("id", { ascending: true }).range(off, off + 999);
      if (error) break;
      for (const rc of rcs ?? []) received.set(rc.item_id as string, (received.get(rc.item_id as string) || 0) + (Number(rc.qty) || 0));
      if ((rcs ?? []).length < 1000) break;
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

  // 1) 붙일 행 준비 — 삽입 실패는 건너뛰되 failed 에 남긴다(조용히 빠지면 원장엔 있고 요청서엔 없는 입고가 된다)
  const out: LinkResult = { ok: true, req_no: reqNo, status: head.status, lines: [], failed: [] };
  type Plan = { e: AllocEntry; it: Item; qty: number; left: number };
  const plans: Plan[] = [];
  for (const e of positive) {
    const qty = Math.round(e.qty * 100) / 100;
    const pr = prior.get(e.inv_txn_id);
    const left = Math.round((qty - (pr?.qty || 0)) * 100) / 100;
    if (left <= 0) {
      // 이미 연결됨 — 이 요청서면 재호출(조용히 건너뜀), 다른 요청서면 알린다(옮기려면 그쪽 연결을 먼저 해제)
      if (pr && ![...pr.requestIds].includes(requestId)) out.failed!.push({ product_id: e.product_id, qty, reason: "이미 다른 요청서에 연결된 입고" });
      continue;
    }
    const real = items.find((it) => it.product_id === e.product_id && it.requested_qty > 0);
    let it: Item | null = real ?? null;
    if (!it) {
      if (bundleParents.has(e.product_id)) continue; // 묶음은 요청서에 못 담는다 — 연결 없는 일반 입고
      it = await ensureUnrequestedLine(e.product_id);
      if (!it) { out.failed!.push({ product_id: e.product_id, qty: left, reason: `'${UNREQUESTED_ITEM_MEMO}' 줄 생성 실패` }); continue; }
    }
    plans.push({ e, it, qty, left });
  }

  // 2) 한 번에 넣기 — 102 유니크(item_id, inv_txn_id) 충돌은 무시. 미적용 환경은 일반 insert(한 문장)로 폴백.
  const rowOf = (p: Plan): Record<string, unknown> => ({
    request_id: requestId, item_id: p.it.id, qty: p.left, memo: LINK_MEMO, received_by: actor, inv_txn_id: p.e.inv_txn_id,
    ...(p.e.receipt_date && /^\d{4}-\d{2}-\d{2}$/.test(p.e.receipt_date) ? { receipt_date: p.e.receipt_date } : {}),
  });
  const appliedBy = new Map<Plan, number>();
  if (plans.length) {
    const rows = plans.map(rowOf);
    let up = await sb.from("production_receipts").upsert(rows, { onConflict: "item_id,inv_txn_id", ignoreDuplicates: true }).select("item_id, inv_txn_id");
    let plain = false;
    if (up.error && /no unique|exclusion constraint|on conflict/i.test(up.error.message)) {
      up = await sb.from("production_receipts").insert(rows).select("item_id, inv_txn_id");
      plain = true;
    }
    if (up.error) {
      console.warn("[production-allocate] link insert failed", up.error.message);
      for (const p of plans) out.failed!.push({ product_id: p.e.product_id, qty: p.left, reason: up.error.message });
    } else {
      const got = new Set((up.data ?? []).map((r) => `${r.item_id}|${r.inv_txn_id}`));
      for (const p of plans) {
        if (plain || got.has(`${p.it.id}|${p.e.inv_txn_id}`)) { appliedBy.set(p, p.left); continue; }
        // 충돌로 빠진 쌍 — 같은 줄·같은 원장에 일부만 붙어 있던 경우의 증액(드묾, 줄 단위로 맞춘다)
        const r2 = await topUpPair(sb, p.it.id, Number.POSITIVE_INFINITY, p.e.inv_txn_id, p.qty);
        if (!r2) { out.failed!.push({ product_id: p.e.product_id, qty: p.left, reason: "기존 연결 재확인 실패" }); continue; }
        if (r2.applied > 0) appliedBy.set(p, r2.applied);
      }
    }
  }
  for (const [p, applied] of appliedBy) {
    const before = received.get(p.it.id) || 0;
    received.set(p.it.id, before + applied);
    const over = p.it.requested_qty > 0 ? Math.min(applied, Math.max(0, Math.round((before + applied - p.it.requested_qty) * 100) / 100)) : 0;
    out.lines.push({ product_id: p.e.product_id, qty: applied, over, unrequested: p.it.requested_qty <= 0 });
  }

  // 3) 알림 한 건(요청서당) — 응답 뒤에. 요약 형식은 그대로('생산 입고 · 번호 · 품목 ×수량'), 품목별 내역은 본문에.
  if (out.lines.length) {
    const nm = (pid: string) => nameById.get(pid) || "품목";
    const first = nm(out.lines[0].product_id);
    const title = out.lines.length === 1 ? first : `${first} 외 ${out.lines.length - 1}종`;
    const total = Math.round(out.lines.reduce((a, l) => a + l.qty, 0) * 100) / 100;
    const detail = [
      LINK_MEMO,
      ...out.lines.slice(0, 30).map((l) => `- ${nm(l.product_id)} ×${l.qty.toLocaleString()}${l.unrequested ? ` ${UNREQUESTED_ITEM_MEMO}` : l.over > 0 ? ` (초과 ${l.over.toLocaleString()})` : ""}`),
      ...(out.lines.length > 30 ? [`- 외 ${out.lines.length - 30}품목`] : []),
      ...(out.failed!.length ? [`연결 실패 ${out.failed!.length}품목 — 생산 요청 화면의 [입고 연결]로 다시 연결하세요`] : []),
    ].join("\n");
    deferNotify(() => logProductionReceipt(reqNo, title, total, actor, detail));
  }

  // 상태 전환은 recheckRequestCompletion 한 곳에서 — 요청→진행중(부분) 또는 →완료(전 품목 100%↑, 도매 요청서와 같은 규칙)
  if (out.lines.length) {
    await recheckRequestCompletion(sb, [requestId], "입고 기록");
    try {
      const { data: afterRow } = await sb.from("production_requests").select("status").eq("id", requestId).maybeSingle();
      if (afterRow?.status) out.status = String(afterRow.status);
    } catch { /* 상태 모름 — 화면은 목록 재조회 */ }
  }
  return out;
}

// 입고 원장 취소(삭제) 전에 부르는 준비 — 그 원장에 연결된 요청서 중 '지금 100% 완료' 인 것만 돌려준다.
//  삭제(cascade) 뒤 recheckRequestCompletion(..., "reopen") 에 넘기면 100% 아래로 내려간 완료만 재개되고,
//  사람이 미달인 채 마감한 요청서는 되살아나지 않는다(수동 완료 보존 규칙).
//  조회 실패는 null — 호출부가 취소를 중단한다(삼키면 100% 아래인데 '완료'로 굳는다). getRequestFullness null(조회 실패)도 null.
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
      if (!f) return null;
      if (f.full && f.status === "완료") out.push(rid);
    }
    return out;
  } catch { return null; }
}
