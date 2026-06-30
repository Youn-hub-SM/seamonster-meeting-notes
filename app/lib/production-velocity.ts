import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 판매속도(출고추세) — 자체 재고원장(inventory_txns)의 '출고'를 SKU별 일평균으로 집계.
//  (2026-06 박스히어로 API 의존 제거 → 자체 원장 전환. 전수 집계라 빠르고 정확, 캐시 불필요.)
//  출고 = 소매 판매(판매 엑셀 업로드 등). status 컬럼이 있으면 '완료'만 집계.
// ─────────────────────────────────────────────

const WINDOW_DAYS = 30;

export interface VelocitySnapshot {
  computedAt: string;     // ISO
  spanDays: number;       // 실제 집계가 커버한 일수(가장 오래된 출고 ~ 오늘, 최대 WINDOW_DAYS)
  txCount: number;        // 집계에 쓴 출고 라인 수
  capped: boolean;        // 원장 전수 집계라 항상 false(이전 인터페이스 호환 유지)
  perSku: Record<string, number>; // SKU(대문자) → 일평균 출고량
}

const kstToday = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const dayMs = 86400_000;
const dateAt = (base: string, deltaDays: number) => new Date(Date.parse(base + "T00:00:00Z") + deltaDays * dayMs).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / dayMs);

interface OutRow { qty: number; txn_date: string; status?: string | null; shipment_id?: string | null; products?: { sku: string | null } | null }

// 최근 windowDays 출고 → SKU별 일평균. 소매(shipment_id 없는 출고)만 — B2B 도매 출고는 제외.
//  status(034)·shipment_id(035) 컬럼 유무에 따라 단계적 폴백 select.
export async function getLedgerVelocity(windowDays = WINDOW_DAYS): Promise<VelocitySnapshot> {
  const sb = supabaseAdmin();
  const today = kstToday();
  const fromD = dateAt(today, -windowDays);

  const selects = [
    "qty, txn_date, status, shipment_id, products(sku)",
    "qty, txn_date, status, products(sku)",
    "qty, txn_date, products(sku)",
  ];
  let rows: OutRow[] = [];
  for (const sel of selects) {
    const res = await sb.from("inventory_txns").select(sel).eq("type", "출고").gte("txn_date", fromD).limit(20000);
    if (!res.error) { rows = (res.data ?? []) as unknown as OutRow[]; break; }
  }

  const totals = new Map<string, number>();
  let oldest = today;
  let txCount = 0;
  for (const r of rows) {
    if (r.status != null && r.status !== "완료") continue; // 대기 출고 제외
    if (r.shipment_id != null) continue;                   // B2B 도매 출고 제외(소매 속도만)
    const sku = r.products?.sku ? String(r.products.sku).toUpperCase() : null;
    if (!sku) continue;
    const q = Math.abs(Number(r.qty) || 0);
    if (!q) continue;
    totals.set(sku, (totals.get(sku) || 0) + q);
    if (r.txn_date && r.txn_date < oldest) oldest = r.txn_date;
    txCount++;
  }
  const spanDays = Math.min(windowDays, Math.max(1, daysBetween(oldest, today) || 1));
  const perSku: Record<string, number> = {};
  for (const [sku, total] of totals) perSku[sku] = total / spanDays;

  return { computedAt: new Date().toISOString(), spanDays, txCount, capped: false, perSku };
}
