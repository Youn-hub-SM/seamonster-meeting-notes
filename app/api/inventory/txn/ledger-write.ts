// 수동 원장 쓰기(입출고 단건·엑셀/구매 일괄·재고 이동) 공용 — 중복 방지 키(131)와 미적용 폴백.
//  docs/ledger-standard.md S2: 화면이 제출마다 키를 하나 만들고 재시도에도 같은 키를 보낸다.
//  서버는 행마다 request_key='<키>:<순번>' 을 넣는다 → 두 번째 insert 는 유니크(inv_txn_request_key_uniq)로 23505,
//  다행 insert 는 한 문장이라 아무 행도 안 들어간다. 그때 기존 행을 읽어 같은 결과를 돌려준다.
import type { supabaseAdmin } from "@/app/lib/supabase";
import { B2B_SHIP_BY, B2B_CANCEL_KEPT_SOURCE } from "@/app/lib/b2b-shipments";
import { missingTable } from "@/app/lib/fulfill-db";

type Sb = ReturnType<typeof supabaseAdmin>;
type PgErr = { code?: string; message?: string } | null | undefined;

export const LEDGER_131_COLS = ["request_key", "source", "source_ref"] as const;

// 화면이 보낸 제출 키 — uuid 류만 받는다(LIKE 와일드카드·구분자 ':' 가 섞이지 않게). 없거나 형식이 다르면 null(종전 동작).
export function parseRequestKey(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9-]{16,64}$/.test(s) ? s : null;
}

// 같은 키로 이미 기록됨(유니크 위반) — 다른 유니크는 inventory_txns 에 없지만 인덱스 이름으로 확인한다
export function isDupRequestKey(err: PgErr): boolean {
  return !!err && err.code === "23505" && /request_key/i.test(err.message || "");
}

// 131 미적용 — 새 칸이 '없는 칸'으로 거부됨. 셋을 한 번에 뺀다(하나씩 빼면 다음 칸에서 또 실패한다).
//  23505(중복) 메시지에도 request_key 가 보이므로 반드시 isDupRequestKey 를 먼저 본다.
export function isMissing131(err: PgErr): boolean {
  if (!err || err.code === "23505") return false;
  const m = err.message || "";
  return (err.code === "PGRST204" || err.code === "42703" || /could not find|does not exist|schema cache/i.test(m))
    && /request_key|source_ref|\bsource\b/i.test(m);
}

export function strip131(rows: Record<string, unknown>[]): void {
  for (const r of rows) for (const c of LEDGER_131_COLS) delete r[c];
}

// 이 키로 이미 기록된 행(순번 순). 조회 실패는 error — 호출부는 '모름'으로 멈춘다(S4).
export async function loadByRequestKey<T extends Record<string, unknown>>(
  sb: Sb, key: string, select: string,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let off = 0; off < 100000; off += 1000) {
    const { data, error } = await sb.from("inventory_txns").select(select)
      .like("request_key", `${key}:%`).order("request_key", { ascending: true }).range(off, off + 999);
    if (error) return { rows, error: error.message };
    rows.push(...((data ?? []) as unknown as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return { rows, error: null };
}

// 재시도가 '같은 내용'인가 — (품목·유형·칸·수량·거래일·상태·사유·단가) 다중집합 비교. 다르면 같은 키로 다른 내용을 보낸 것
//  (입력을 고친 뒤 재전송)이라 이미 저장된 기록을 알리고 멈춘다. 같으면 같은 결과를 그대로 돌려준다.
//  거래일·상태는 오늘 재고(D1)·대기 미반영을 직접 바꾸는 값이라 빠지면 '대기로 고쳐 다시 보냄'이 옛 '완료'로 조용히 replay 된다.
//  호출부의 조회(select)에 이 칸들이 모두 있어야 한다. 상태 없음(조정·034 이전) = DB 기본값 '완료'.
type Cmp = { product_id?: unknown; type?: unknown; channel?: unknown; qty?: unknown; txn_date?: unknown; status?: unknown; reason?: unknown; unit_amount?: unknown };
export function sameLedgerRows(a: Cmp[], b: Cmp[]): boolean {
  if (a.length !== b.length) return false;
  const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
  const sig = (r: Cmp) => [
    r.product_id, r.type, r.channel ?? "", num(r.qty),
    String(r.txn_date ?? "").slice(0, 10), r.status ?? "완료", r.reason ?? "",
    r.unit_amount == null || r.unit_amount === "" ? "" : num(r.unit_amount),
  ].join("|");
  const count = new Map<string, number>();
  for (const r of a) count.set(sig(r), (count.get(sig(r)) || 0) + 1);
  for (const r of b) {
    const k = sig(r);
    const n = count.get(k) || 0;
    if (!n) return false;
    count.set(k, n - 1);
  }
  return true;
}

// 이미 기록된 입고 중 요청서 연결이 안 된 행 — 재시도에서 끊긴 연결만 마저 채운다(연결된 행까지 다시 넘기면
//  그 사이 자동 완료된 요청서에 '열린 요청서에만 연결' 안내가 떠 헷갈린다). 조회 실패는 null(호출부는 연결하지 않고 알린다).
export async function unlinkedOf(sb: Sb, ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set();
  const linked = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("production_receipts").select("inv_txn_id").in("inv_txn_id", ids.slice(i, i + 100)).limit(5000);
    if (error) return null;
    for (const r of data ?? []) if (r.inv_txn_id) linked.add(String(r.inv_txn_id));
  }
  return new Set(ids.filter((id) => !linked.has(id)));
}

// 화면 안내 — 같은 키로 다른 내용이 왔을 때. 화면은 키를 새로 만들어 다음 누름은 새 기록이 되게 한다.
export const REQUEST_KEY_CONFLICT_MSG = "이 요청은 이미 다른 내용으로 저장돼 있습니다 — [입고 및 출고] 목록을 먼저 확인하세요. 그래도 새로 기록하려면 다시 누르세요.";

// 출처 칸에 '채널이동'을 사람이 적으면 그 출고가 판매에서 빠지고 이동으로 오인된다(S11) — 사람 입력에서는 받지 않는다
export const RESERVED_PARTNER = "채널이동";
export function isReservedPartner(v: unknown): boolean {
  return String(v ?? "").trim() === RESERVED_PARTNER;
}

// ── 한 줄 취소·상태 변경을 막는 연동 행(S7·S11) — txn DELETE · orders DELETE/PATCH 공용 ──
//  판정은 출처 칸(131 source) 우선, 그 전 기록은 종전 표식(주문번호 없는 partner '채널이동' · shipment_id · created_by 'B2B 자동출고').
//  주문번호가 있는 '채널이동' 행은 예전에 사람이 거래처에 그 글자를 적은 입출고라(이동·합류엔 주문번호가 없다) 일반 행으로 본다.
//  move = 칸 이동·프로모션 마감 합류(짝으로만 취소) · b2b_ship = 발송 선점(발주 발송일정에서) · b2b_kept = 발송 후 취소 미반품 출고(발주 복구 때 정리).
export type LedgerMark = { source?: unknown; partner?: unknown; order_no?: unknown; shipment_id?: unknown; created_by?: unknown };
export type LockKind = "move" | "b2b_ship" | "b2b_kept";
export function lockKindOf(r: LedgerMark): LockKind | null {
  const src = String(r.source ?? "");
  if (src === "move" || src === "promo_close") return "move";
  if (!src && r.partner === RESERVED_PARTNER && !r.order_no) return "move";
  if (src === B2B_CANCEL_KEPT_SOURCE) return "b2b_kept";
  if (src.startsWith("b2b") || r.shipment_id || r.created_by === B2B_SHIP_BY) return "b2b_ship";
  return null;
}
export const LOCK_MSG: Record<LockKind, string> = {
  move: "재고 이동(칸 이동·프로모션 마감 합류) 기록입니다 — [재고 이동] 최근 내역, [입고 및 출고] 목록의 이동 행, [변경 기록]의 취소 중 한 곳에서 취소하세요(두 칸이 함께 원복됩니다). 프로모션 마감 합류는 생산 요청에서 그 요청서를 먼저 다시 연 뒤 취소합니다.",
  b2b_ship: "B2B 발송 선점 출고입니다 — 발주의 발송일정에서 수정·삭제하세요(재고가 함께 원복됩니다).",
  b2b_kept: "발송 후 취소(미반품) 출고입니다 — 발주를 복구하면 함께 정리됩니다. 물건이 돌아왔으면 입고 사유 '고객 반품'으로 입고하세요.",
};

// 온라인발주 출고 배치(fulfill_dispatch)의 한 줄인가 — 한 줄 취소는 수량 정정용이라 배치의 주문은 처리완료로 남는다.
//  'dispatch' = 배치 본 출고(131 source 'fulfill', 그 전 기록은 group_id = fulfill_dispatch.group_id 로 확인)
//  'late' = 미반영분 출고([재고 차감 기록], source 'fulfill_unmatched'). 조회 실패는 'error' — 호출부는 멈춘다(S4).
export type FulfillBatch = "dispatch" | "late";
export async function fulfillBatchOf(sb: Sb, r: { source?: unknown; group_id?: unknown }): Promise<FulfillBatch | "error" | null> {
  const src = String(r.source ?? "");
  if (src === "fulfill_unmatched") return "late";
  if (src === "fulfill") return "dispatch";
  if (src || !r.group_id) return null; // 출처가 다른 행(manual·import·adjust_import 등)은 배치일 수 없다
  const { data, error } = await sb.from("fulfill_dispatch").select("id").eq("group_id", String(r.group_id)).limit(1);
  if (error) return missingTable(error) ? null : "error";
  return data?.length ? "dispatch" : null;
}
// 409 code 'confirm_required' 응답 — error 는 확인창을 모르는 화면이 그대로 띄우는 안내(다시 누르라고 하지 않는다 — 같은 요청은 또 409),
//  confirm 은 확인창 문구. 확인창을 아는 화면은 confirm 으로 묻고 같은 요청에 confirm=1 을 붙여 다시 보낸다.
export const FULFILL_ONE_MSG: Record<FulfillBatch, string> = {
  dispatch: "온라인발주 출고 배치의 한 줄입니다 — 이 줄만 취소하면 재고만 원복되고 그 배치의 주문은 처리완료로 남습니다(수량 정정용). 다시 출고하려면 [입고 및 출고]에서 그 묶음을 취소하세요.",
  late: "온라인발주 미반영분 출고([재고 차감 기록])의 한 줄입니다 — 취소해도 그 코드는 [재고 차감 기록] 목록에 다시 나오지 않습니다(수량 정정용). 묶음 전체를 되돌리려면 [입고 및 출고]에서 그 묶음을 취소하세요.",
};
export const FULFILL_ONE_CONFIRM: Record<FulfillBatch, string> = {
  dispatch: "온라인발주 출고 배치의 한 줄입니다. 이 줄의 재고만 원복되고 그 배치의 주문은 처리완료로 남습니다(수량 정정용). 다시 출고하려면 [입고 및 출고]에서 묶음으로 취소해야 합니다.\n\n이 줄만 취소할까요?",
  late: "온라인발주 미반영분 출고의 한 줄입니다. 취소해도 그 코드는 [재고 차감 기록] 목록에 다시 나오지 않습니다(수량 정정용).\n\n이 줄만 취소할까요?",
};

// 사유(099) — 출고: 판매(null)·협찬·폐기·제조사 반품·기타 / 입고: 일반(null)·고객 반품(D4b, 2026-10-11)
export const OUT_REASONS = ["협찬", "폐기", "제조사 반품", "기타"] as const;
export const IN_REASONS = ["고객 반품"] as const;
export function reasonFor(type: string, v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (type === "출고") return (OUT_REASONS as readonly string[]).includes(s) ? s : null;
  if (type === "입고") return (IN_REASONS as readonly string[]).includes(s) ? s : null;
  return null;
}
