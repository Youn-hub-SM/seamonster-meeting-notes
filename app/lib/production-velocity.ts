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

interface OutRow { qty: number; txn_date: string; status?: string | null; shipment_id?: string | null; channel?: string | null; partner?: string | null; products?: { sku: string | null } | null }

// 최근 windowDays 출고 → SKU별 일평균.
//  channel 미지정(레거시) = 전 채널에서 B2B 발송(shipment) 제외 — 기존 소비처(생산 일정 등) 동작 유지.
//  channel="소매"   = 소매 판매 속도: 소매 채널 출고만, B2B 발송·채널이동 제외.
//  channel="도매"   = 도매 소진 속도: 도매 채널 출고(B2B 발송 포함), 채널이동 제외 —
//                     소매 보충 이동을 빼는 이유: 소매 부족분은 소매 탭 조언이 이미 잡으므로 이중 계상 방지.
//  status(034)·shipment_id(035)·channel(036) 컬럼 유무에 따라 단계적 폴백 select.
export async function getLedgerVelocity(windowDays = WINDOW_DAYS, channel?: "소매" | "도매"): Promise<VelocitySnapshot> {
  const sb = supabaseAdmin();
  const today = kstToday();
  const fromD = dateAt(today, -windowDays);

  const selects = [
    "qty, txn_date, status, shipment_id, channel, partner, products(sku)",
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
    if (r.partner === "채널이동") continue;                 // 소매↔도매 이동은 판매/납품이 아님
    if (channel) {
      if ((r.channel ?? "소매") !== channel) continue;      // 채널 필터(036 미적용 행은 소매 취급)
      if (channel === "소매" && r.shipment_id != null) continue; // 소매 속도에서 B2B 발송 제외
      // 도매 속도는 B2B 발송 포함(납품 소진이 곧 도매 수요)
    } else {
      if (r.shipment_id != null) continue;                  // 레거시: B2B 도매 출고 제외
    }
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
