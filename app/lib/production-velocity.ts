import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 판매속도(출고추세) — 박스히어로 출고 트랜잭션을 SKU별로 집계.
//  트랜잭션 상세가 N+1 이고 5req/s 제한이라, 최근분만 제한 수집 후 b2b_settings 에 캐시.
// ─────────────────────────────────────────────

const BASE = "https://rest.boxhero-app.com";
const VELOCITY_KEY = "production_velocity";
const MAX_DETAIL_FETCH = 40;   // 상세 조회 상한(시간 예산 보호 — 약 8초)
const WINDOW_DAYS = 30;

export interface VelocitySnapshot {
  computedAt: string;     // ISO
  spanDays: number;       // 실제 집계가 커버한 일수
  txCount: number;        // 집계에 쓴 출고 트랜잭션 수
  capped: boolean;        // 상한에 걸려 일부만 집계했는지
  perSku: Record<string, number>; // SKU(대문자) → 일평균 출고량
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TxHeader { id: number; transaction_time: string; type: string }
interface TxDetailItem { sku: string | null; quantity: number }

async function bhFetch(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`박스히어로 트랜잭션 조회 실패 (${res.status})`);
  return res.json();
}

// 출고 트랜잭션 헤더 목록 (최근 WINDOW_DAYS, 최대 MAX_DETAIL_FETCH 건)
async function listRecentOutTx(token: string): Promise<{ ids: number[]; spanDays: number; capped: boolean }> {
  const cutoff = Date.now() - WINDOW_DAYS * 86400_000;
  const ids: number[] = [];
  let cursor: number | null = null;
  let oldest = Date.now();
  let capped = false;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ type: "out", limit: "100" });
    if (cursor != null) qs.set("cursor", String(cursor));
    const j = (await bhFetch(`/v1/transactions?${qs}`, token)) as { items?: TxHeader[]; has_more?: boolean; cursor?: number | null };
    const items = j.items || [];
    for (const t of items) {
      const tm = new Date(t.transaction_time).getTime();
      if (tm < cutoff) break;
      if (ids.length >= MAX_DETAIL_FETCH) { capped = true; break; }
      ids.push(t.id);
      oldest = Math.min(oldest, tm);
    }
    const last = items[items.length - 1];
    if (capped || !j.has_more || j.cursor == null || !last || new Date(last.transaction_time).getTime() < cutoff) break;
    cursor = j.cursor;
  }
  const spanDays = Math.max(1, Math.round((Date.now() - oldest) / 86400_000));
  return { ids, spanDays, capped };
}

async function fetchTxOutBySku(id: number, token: string): Promise<Map<string, number>> {
  const j = (await bhFetch(`/v1/transactions/${id}`, token)) as { item?: { items?: TxDetailItem[] } };
  const m = new Map<string, number>();
  for (const it of j.item?.items || []) {
    if (!it.sku) continue;
    const k = String(it.sku).toUpperCase();
    m.set(k, (m.get(k) || 0) + Math.abs(Number(it.quantity) || 0));
  }
  return m;
}

// 판매속도 계산 (5req/s 준수: 5건씩 배치 + 1.1s 간격)
export async function computeVelocity(token: string): Promise<VelocitySnapshot> {
  const { ids, spanDays, capped } = await listRecentOutTx(token);
  const totals = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const maps = await Promise.all(batch.map((id) => fetchTxOutBySku(id, token).catch(() => new Map<string, number>())));
    for (const m of maps) for (const [sku, q] of m) totals.set(sku, (totals.get(sku) || 0) + q);
    if (i + 5 < ids.length) await sleep(1100);
  }
  const perSku: Record<string, number> = {};
  for (const [sku, total] of totals) perSku[sku] = total / spanDays;
  return {
    computedAt: new Date().toISOString(),
    spanDays,
    txCount: ids.length,
    capped,
    perSku,
  };
}

export async function getVelocitySnapshot(): Promise<VelocitySnapshot | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", VELOCITY_KEY).maybeSingle();
    if (error || !data) return null;
    return (data.value as VelocitySnapshot) || null;
  } catch {
    return null;
  }
}

export async function saveVelocitySnapshot(snap: VelocitySnapshot): Promise<void> {
  const sb = supabaseAdmin();
  await sb.from("b2b_settings").upsert(
    { key: VELOCITY_KEY, value: snap, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

// 캐시가 신선하면(기본 6시간) 그대로, 아니면 재계산 후 저장.
export async function getOrRefreshVelocity(token: string, maxAgeMs = 6 * 3600_000): Promise<VelocitySnapshot> {
  const cached = await getVelocitySnapshot();
  if (cached && Date.now() - new Date(cached.computedAt).getTime() < maxAgeMs) return cached;
  const fresh = await computeVelocity(token);
  await saveVelocitySnapshot(fresh);
  return fresh;
}
