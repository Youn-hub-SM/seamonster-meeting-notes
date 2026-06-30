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

interface OutRow { qty: number; txn_date: string; status?: string | null; products?: { sku: string | null } | null }

// 최근 windowDays 출고 → SKU별 일평균. status 미적용(034) 환경은 폴백 select.
export async function getLedgerVelocity(windowDays = WINDOW_DAYS): Promise<VelocitySnapshot> {
  const sb = supabaseAdmin();
  const today = kstToday();
  const fromD = dateAt(today, -windowDays);

  const withStatus = await sb.from("inventory_txns").select("qty, txn_date, status, products(sku)").eq("type", "출고").gte("txn_date", fromD).limit(20000);
  let rows = (withStatus.data ?? []) as unknown as OutRow[];
  if (withStatus.error) { // 034(status) 미적용 폴백
    const base = await sb.from("inventory_txns").select("qty, txn_date, products(sku)").eq("type", "출고").gte("txn_date", fromD).limit(20000);
    rows = (base.data ?? []) as unknown as OutRow[];
  }

  const totals = new Map<string, number>();
  let oldest = today;
  let txCount = 0;
  for (const r of rows) {
    if (r.status != null && r.status !== "완료") continue; // 대기 출고 제외
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
