// 취소·반품 처리 — 소매 주문 줄을 수량 단위로 취소해 매출 원장에 바로 반영한다(2026-11-20 대표 지시, migration 175). 서버 전용.
//  docs/ledger-standard.md 기준: 반영은 RPC 한 트랜잭션(S3) · 요청 키로 한 번만(S2) · 조회 실패는 멈춤(S4) · 도매·B2B 는 발주에서(S10).
//
//  ■ 매출 — order_cancel_apply 가 매출 행의 수량·금액을 줄이고(남은 수량 0이면 행 삭제), 취소 장부에 원래 값과 스냅샷을 남긴다.
//    행 해시는 그대로 둔다 → 취소 전 파일을 다시 올려도 줄어든 행이 유지된다(해시가 같아 '이미 있음'으로 건너뜀).
//    지운 행은 해시가 없어 다시 들어올 수 있으므로, 매출 업로드(미리보기·적용)가 applyCancelsToRows 로 취소 장부를 먼저 적용한다.
//  ■ 배송일지 박스·재고 — 이 파일은 계획과 결과만 기록한다(order_cancels.box / stock).
//    실제 기록은 화면이 기존 저장 경로(/api/fulfill/log 직접수정, /api/inventory/txn 입고 '고객 반품')로 한다 — 세트 전개·요청 키 규칙을 그대로 쓰려고(S5).
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, fetchInChunks } from "./sales-paging";

export const MISSING_175 = "취소 장부가 없습니다 — migration 175 를 먼저 적용하세요.";
type PgErr = { message?: string; code?: string } | null | undefined;
export const isMissing175 = (e: PgErr) => !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202" || /order_cancel|does not exist|schema cache|could not find the function/i.test(e.message || ""));
export class CancelError extends Error {}

// ── 매출 업로드와의 연결 ──
// 지금 반영돼 있는 취소 — 매출 행 해시마다 뺀 수량·금액 합. 장부가 아직 없으면 빈 맵(종전 동작), 다른 오류는 던진다(S4).
export type CancelNets = Map<string, { qty: number; amount: number }>;
export async function loadCancelNets(sb: SupabaseClient): Promise<CancelNets> {
  const out: CancelNets = new Map();
  let rows: { row_hash: string; cancel_qty: number; cancel_amount: number }[];
  try {
    rows = await fetchAllPages((lo, hi) => sb.from("order_cancel_lines").select("id, row_hash, cancel_qty, cancel_amount").eq("active", true).order("id", { ascending: true }).range(lo, hi), { label: "취소 장부" });
  } catch (e) {
    if (isMissing175(e as PgErr)) return out;
    throw new Error(`취소 장부 조회 오류: ${(e as { message?: string })?.message || e}`);
  }
  for (const r of rows) {
    const c = out.get(r.row_hash) || { qty: 0, amount: 0 };
    c.qty += Number(r.cancel_qty) || 0; c.amount += Number(r.cancel_amount) || 0;
    out.set(r.row_hash, c);
  }
  return out;
}
// 파일 행에 취소를 적용 — 전부 취소한 행은 빼고(dropped), 일부 취소한 행은 남은 수량·금액으로(adjusted). 해시는 그대로.
export function applyCancelsToRows<T extends { row_hash: string; quantity: number; subtotal_amount: number }>(rows: T[], nets: CancelNets): { rows: T[]; dropped: string[]; adjusted: number } {
  if (!nets.size) return { rows, dropped: [], adjusted: 0 };
  const out: T[] = []; const dropped: string[] = []; let adjusted = 0;
  for (const r of rows) {
    const c = nets.get(r.row_hash);
    if (!c) { out.push(r); continue; }
    const qty = r.quantity - c.qty;
    if (qty <= 0) { dropped.push(r.row_hash); continue; }
    out.push({ ...r, quantity: qty, subtotal_amount: Math.max(0, r.subtotal_amount - c.amount) });
    adjusted++;
  }
  return { rows: out, dropped, adjusted };
}

// ── 주문 찾기 ──
export type OrderLine = {
  row_hash: string; channel: string; order_date: string; product_name: string; option_name: string; sku_code: string;
  quantity: number; subtotal_amount: number;        // 지금 남은 수량·금액
  cancelled_qty: number;                             // 이미 취소한 수량
  product_id: string | null; product_label: string | null; stock_tracked: boolean; // 재고에 돌려놓을 품목(상품 마스터에 없으면 null)
};
export type OrderFound = { channel: string; order_id: string; order_date: string; customer: string; lines: OrderLine[]; gone: { product_name: string; option_name: string; qty: number }[] };
const maskName = (n: string) => (n ? n[0] + "*".repeat(Math.max(1, Math.min(n.length - 1, 3))) : "");

export async function findOrders(sb: SupabaseClient, orderId: string): Promise<OrderFound[]> {
  const id = orderId.trim();
  if (!id) throw new CancelError("주문번호를 입력하세요.");
  const { data, error } = await sb.from("sales_orders")
    .select("row_hash, channel, order_date, order_id, product_name, option_name, sku_code, quantity, subtotal_amount, customer_key, source")
    .eq("order_id", id).order("channel", { ascending: true }).order("product_name", { ascending: true }).limit(500);
  if (error) throw new Error(`주문 조회 오류: ${error.message}`);
  type Row = { row_hash: string; channel: string; order_date: string; order_id: string; product_name: string; option_name: string; sku_code: string; quantity: number; subtotal_amount: number; customer_key: string; source: string | null };
  const rows = ((data ?? []) as Row[]).filter((r) => r.channel !== "도매" && r.source !== "b2b");

  // 이 주문의 취소 기록 — 이미 취소한 수량, 전부 취소돼 원장에서 빠진 줄
  const { data: cs, error: ce } = await sb.from("order_cancels").select("id, channel, order_cancel_lines(row_hash, product_name, option_name, cancel_qty, active)").eq("order_id", id).eq("status", "active");
  if (ce) { if (isMissing175(ce)) throw new CancelError(MISSING_175); throw new Error(`취소 기록 조회 오류: ${ce.message}`); }
  type CL = { row_hash: string; product_name: string | null; option_name: string | null; cancel_qty: number; active: boolean };
  const cancels = ((cs ?? []) as unknown as { channel: string; order_cancel_lines: CL[] }[]).flatMap((c) => (c.order_cancel_lines || []).filter((l) => l.active).map((l) => ({ ...l, channel: c.channel })));
  const cancelledBy = new Map<string, number>();
  for (const l of cancels) cancelledBy.set(l.row_hash, (cancelledBy.get(l.row_hash) || 0) + Number(l.cancel_qty));

  // 상품 코드 → 상품 마스터(재고에 돌려놓을 품목)
  const skus = [...new Set(rows.flatMap((r) => { const s = (r.sku_code || "").trim(); return s ? [s, s.toUpperCase()] : []; }))]; // 대소문자가 다르게 적힌 코드도 찾게
  const prodBySku = new Map<string, { id: string; label: string; tracked: boolean }>();
  if (skus.length) {
    const prods = await fetchInChunks<{ id: string; sku: string | null; name: string; spec: string | null; stock_tracked: boolean | null }>(skus, (part, lo, hi) => sb.from("products").select("id, sku, name, spec, stock_tracked").in("sku", part).order("id", { ascending: true }).range(lo, hi));
    for (const p of prods) if (p.sku) prodBySku.set(p.sku.toUpperCase(), { id: p.id, label: [p.name, p.spec].filter(Boolean).join(" "), tracked: p.stock_tracked !== false });
  }
  // 고객 이름(가려서) — 맞는 주문인지 확인용
  const keys = [...new Set(rows.map((r) => r.customer_key).filter(Boolean))];
  const nameBy = new Map<string, string>();
  if (keys.length) {
    const cu = await fetchInChunks<{ customer_key: string; customer_name: string | null }>(keys, (part, lo, hi) => sb.from("sales_customers").select("customer_key, customer_name").in("customer_key", part).order("customer_key", { ascending: true }).range(lo, hi));
    for (const c of cu) nameBy.set(c.customer_key, maskName((c.customer_name || "").trim()));
  }

  const byChannel = new Map<string, OrderFound>();
  const get = (channel: string, order_date: string, key: string) => {
    let o = byChannel.get(channel);
    if (!o) { o = { channel, order_id: id, order_date, customer: nameBy.get(key) || "", lines: [], gone: [] }; byChannel.set(channel, o); }
    return o;
  };
  const alive = new Set<string>();
  for (const r of rows) {
    alive.add(r.row_hash);
    const p = prodBySku.get((r.sku_code || "").trim().toUpperCase()) || null;
    get(r.channel, r.order_date, r.customer_key).lines.push({
      row_hash: r.row_hash, channel: r.channel, order_date: r.order_date, product_name: r.product_name, option_name: r.option_name, sku_code: r.sku_code,
      quantity: Number(r.quantity) || 0, subtotal_amount: Number(r.subtotal_amount) || 0, cancelled_qty: cancelledBy.get(r.row_hash) || 0,
      product_id: p?.id ?? null, product_label: p?.label ?? null, stock_tracked: p?.tracked ?? false,
    });
  }
  // 전부 취소돼 원장에 없는 줄 — 주문이 통째로 취소됐으면 이것만 나온다
  const goneBy = new Map<string, { channel: string; product_name: string; option_name: string; qty: number }>();
  for (const l of cancels) if (!alive.has(l.row_hash)) {
    const g = goneBy.get(l.row_hash) || { channel: l.channel, product_name: l.product_name || "", option_name: l.option_name || "", qty: 0 };
    g.qty += Number(l.cancel_qty); goneBy.set(l.row_hash, g);
  }
  for (const g of goneBy.values()) get(g.channel, "", "").gone.push({ product_name: g.product_name, option_name: g.option_name, qty: g.qty });
  return [...byChannel.values()];
}

// ── 취소 반영 ──
export type BoxPlan = { date: string; side: "n" | "g"; category: string; qty: number; entry_id?: string | null; done?: boolean };
export type StockPlan = { product_id: string; name: string; qty: number; request_key: string; txn_ids?: string[]; done?: boolean };
export type ApplyInput = { requestKey: string; kind: string; channel: string; orderId: string; note: string; lines: { row_hash: string; qty: number; amount: number }[]; box: BoxPlan | null; stock: StockPlan[]; by: string };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const posInt = (v: unknown): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

export function normalizeApply(b: Record<string, unknown>, by: string): ApplyInput {
  if (!UUID_RE.test(String(b.requestKey || ""))) throw new CancelError("요청 번호가 없습니다 — 주문을 다시 찾으세요.");
  const kind = String(b.kind || "");
  if (kind !== "취소" && kind !== "반품") throw new CancelError("구분(취소·반품)을 고르세요.");
  const channel = String(b.channel || "").trim(), orderId = String(b.orderId || "").trim();
  if (!channel || !orderId) throw new CancelError("주문을 다시 찾으세요.");
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => l as Record<string, unknown>)
    .map((l) => ({ row_hash: String(l.row_hash || ""), qty: posInt(l.qty), amount: Math.max(0, Math.round(Number(l.amount) || 0)) }))
    .filter((l) => l.row_hash && l.qty > 0);
  if (!lines.length) throw new CancelError("취소할 상품의 수량을 넣으세요.");
  let box: BoxPlan | null = null;
  if (b.box && typeof b.box === "object") {
    const x = b.box as Record<string, unknown>;
    const date = String(x.date || ""), category = String(x.category || "").trim(), qty = posInt(x.qty);
    if (!DATE_RE.test(date)) throw new CancelError("배송일지 날짜를 고르세요.");
    if (!category) throw new CancelError("뺄 박스 종류를 고르세요.");
    if (!qty) throw new CancelError("뺄 박스 수를 넣으세요.");
    box = { date, side: x.side === "g" ? "g" : "n", category, qty, entry_id: randomUUID(), done: false }; // entry_id = 배송일지 직접수정 내역의 id(이 id 로 한 번만 기록된다)
  }
  const stock: StockPlan[] = (Array.isArray(b.stock) ? b.stock : []).map((s) => s as Record<string, unknown>)
    .map((s) => ({ product_id: String(s.product_id || ""), name: String(s.name || "").slice(0, 200), qty: posInt(s.qty), request_key: randomUUID(), txn_ids: [], done: false }))
    .filter((s) => s.product_id && s.qty > 0);
  return { requestKey: String(b.requestKey), kind, channel, orderId, note: String(b.note || "").trim().slice(0, 300), lines, box, stock, by };
}

export type CancelRecord = {
  id: number; kind: string; channel: string; order_id: string; order_date: string | null; note: string | null; cancel_qty: number; cancel_amount: number;
  box: BoxPlan | null; stock: StockPlan[] | null; status: "active" | "reverted"; created_by: string | null; created_at: string; reverted_by: string | null; reverted_at: string | null;
  lines: { product_name: string | null; option_name: string | null; sku_code: string | null; cancel_qty: number; cancel_amount: number }[];
};
const REC_COLS = "id, kind, channel, order_id, order_date, note, cancel_qty, cancel_amount, box, stock, status, created_by, created_at, reverted_by, reverted_at, order_cancel_lines(product_name, option_name, sku_code, cancel_qty, cancel_amount)";
const toRecord = (r: Record<string, unknown>): CancelRecord => { const { order_cancel_lines, ...rest } = r as Record<string, unknown> & { order_cancel_lines?: CancelRecord["lines"] }; return { ...(rest as unknown as Omit<CancelRecord, "lines">), lines: order_cancel_lines || [] }; };

export async function getCancel(sb: SupabaseClient, id: number): Promise<CancelRecord> {
  const { data, error } = await sb.from("order_cancels").select(REC_COLS).eq("id", id).maybeSingle();
  if (error) { if (isMissing175(error)) throw new CancelError(MISSING_175); throw new Error(`취소 기록 조회 오류: ${error.message}`); }
  if (!data) throw new CancelError("취소 기록을 찾지 못했습니다.");
  return toRecord(data as unknown as Record<string, unknown>);
}
// 표가 아직 없으면 null — 화면이 안내를 보인다
export async function listCancels(sb: SupabaseClient): Promise<CancelRecord[] | null> {
  const { data, error } = await sb.from("order_cancels").select(REC_COLS).order("created_at", { ascending: false }).limit(100);
  if (error) { if (isMissing175(error)) return null; throw new Error(`취소 기록 조회 오류: ${error.message}`); }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRecord);
}

const rpcError = (e: PgErr, fallback: string): Error => {
  if (e?.code === "P0001") return new CancelError(e.message || fallback); // 함수가 일부러 던진 안내 문구
  if (isMissing175(e)) return new CancelError(MISSING_175);
  return new Error(`${fallback}: ${e?.message || ""}`);
};
export async function applyCancel(sb: SupabaseClient, p: ApplyInput): Promise<{ record: CancelRecord; replay: boolean }> {
  const { data, error } = await sb.rpc("order_cancel_apply", {
    p_key: p.requestKey, p_kind: p.kind, p_channel: p.channel, p_order_id: p.orderId, p_note: p.note, p_by: p.by,
    p_lines: p.lines, p_box: p.box, p_stock: p.stock.length ? p.stock : null,
  });
  if (error) throw rpcError(error, "취소를 반영하지 못했습니다");
  const out = (data || {}) as { id?: number; replay?: boolean };
  if (!out.id) throw new Error("취소를 반영했는지 확인하지 못했습니다 — 아래 기록을 확인하세요.");
  return { record: await getCancel(sb, Number(out.id)), replay: !!out.replay };
}
export async function revertCancel(sb: SupabaseClient, id: number, by: string): Promise<{ record: CancelRecord; missing: number; replay: boolean }> {
  const { data, error } = await sb.rpc("order_cancel_revert", { p_id: id, p_by: by });
  if (error) throw rpcError(error, "되돌리지 못했습니다");
  const out = (data || {}) as { missing?: number; replay?: boolean };
  return { record: await getCancel(sb, id), missing: Number(out.missing) || 0, replay: !!out.replay };
}
// 박스·재고 단계의 결과 기록 — 화면이 기존 저장 경로로 기록한 뒤 부른다
export async function markSteps(sb: SupabaseClient, id: number, patch: { box?: BoxPlan | null; stock?: StockPlan[] | null }): Promise<CancelRecord> {
  const upd: Record<string, unknown> = {};
  if (patch.box !== undefined) upd.box = patch.box;
  if (patch.stock !== undefined) upd.stock = patch.stock;
  if (Object.keys(upd).length) {
    const { error } = await sb.from("order_cancels").update(upd).eq("id", id);
    if (error) throw new Error(`처리 결과를 기록하지 못했습니다: ${error.message}`);
  }
  return getCancel(sb, id);
}
