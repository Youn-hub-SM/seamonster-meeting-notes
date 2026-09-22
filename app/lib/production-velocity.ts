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
//  channel="도매"   = 도매 소진 속도(5단계, 기획 6절): 도매 채널 출고(B2B 발송 포함), 채널이동 제외.
//    · max(30일 평균, 90일 평균) — 총량이 성장 중이라 90일만 쓰면 과소, SKU 가 듬성해 30일만 쓰면 0.
//    · 분모는 창 일수로 고정(30·90) — 종전 spanDays(가장 오래된 출고~오늘)는 창을 넓혀도 분모가
//      같이 줄어 90일 평균이 실제론 더 짧은 평균이 되던 함정. 원장이 창보다 짧으면 최초 거래일부터.
//    · 미래 컷(txn_date ≤ 오늘) — 발송예정일로 미리 찍힌 선점 출고가 오늘의 속도를 부풀리지 않게.
//    · 대량 제외 — 칸 분리(115) 이전 출고에는 대량이 '도매' 칸에 섞여 있으므로
//      shipment_id → shipments.order_id → orders.is_bulk 로 걸러낸다(이후 출고는 칸이 갈라 자동).
//  status(034)·shipment_id(035)·channel(036)·is_bulk(115) 컬럼 유무에 따라 단계적 폴백.
export async function getLedgerVelocity(windowDays = WINDOW_DAYS, channel?: "소매" | "도매"): Promise<VelocitySnapshot> {
  const sb = supabaseAdmin();
  const today = kstToday();
  const isWholesale = channel === "도매";
  const LONG_DAYS = 90; // 도매 장기 창(기획 6절) — max(단기, 장기) 채택
  const fetchDays = isWholesale ? Math.max(windowDays, LONG_DAYS) : windowDays;
  const fromD = dateAt(today, -fetchDays);

  const selects = [
    "qty, txn_date, status, shipment_id, channel, partner, products(sku)",
    "qty, txn_date, status, shipment_id, products(sku)",
    "qty, txn_date, status, products(sku)",
    "qty, txn_date, products(sku)",
  ];
  // ※ 단발 .limit(20000)은 서버 Max Rows(기본 1000)가 우선해 조용히 잘린다 — 판매속도·안전재고·
  //   생산 마감 경보가 축소되던 원인(감사 확정). range 페이징으로 전량 읽는다(안정 정렬 필수).
  let rows: OutRow[] = [];
  for (const sel of selects) {
    const acc: OutRow[] = [];
    let failed = false;
    for (let i = 0; i < 100000; i += 1000) {
      const res = await sb.from("inventory_txns").select(sel).eq("type", "출고").gte("txn_date", fromD)
        .order("txn_date", { ascending: true }).order("id", { ascending: true })
        .range(i, i + 999);
      if (res.error) { failed = true; break; }
      const chunk = (res.data ?? []) as unknown as OutRow[];
      acc.push(...chunk);
      if (chunk.length < 1000) break;
    }
    if (!failed) { rows = acc; break; }
  }

  // 도매 대량 제외(115·기획 6절) — 칸 분리 이전 출고에는 대량이 '도매' 칸에 섞여 있다.
  //  발송 경유 출고(shipment_id)만 발주로 이어지므로, 그 발주의 is_bulk 를 조회해 걸러낸다.
  //  is_bulk 미적용·조회 실패면 전건 일반(= 종전 동작) — 속도가 조금 부풀 뿐 죽지 않는다.
  const bulkShipments = new Set<string>();
  if (isWholesale) {
    try {
      const shipIds = [...new Set(rows.filter((r) => (r.channel ?? "소매") === "도매" && r.shipment_id).map((r) => r.shipment_id as string))];
      const orderByShip = new Map<string, string>();
      for (let i = 0; i < shipIds.length; i += 100) {
        const res = await sb.from("shipments").select("id, order_id").in("id", shipIds.slice(i, i + 100));
        if (res.error) throw res.error;
        for (const x of (res.data ?? []) as { id: string; order_id: string }[]) orderByShip.set(x.id, x.order_id);
      }
      const orderIds = [...new Set([...orderByShip.values()])];
      const bulkOrders = new Set<string>();
      for (let i = 0; i < orderIds.length; i += 100) {
        const res = await sb.from("orders").select("id, is_bulk").in("id", orderIds.slice(i, i + 100));
        if (res.error) { if (/is_bulk/i.test(res.error.message || "")) { break; } throw res.error; } // 115 미적용 → 전건 일반
        for (const x of (res.data ?? []) as { id: string; is_bulk?: boolean }[]) if (x.is_bulk) bulkOrders.add(x.id);
      }
      for (const [sid, oid] of orderByShip) if (bulkOrders.has(oid)) bulkShipments.add(sid);
    } catch { /* 조회 실패 — 전건 일반으로 진행(종전 동작) */ }
  }

  const totals = new Map<string, number>();       // 소매·레거시: 단일 창 / 도매: 장기(90일) 창
  const totalsShort = new Map<string, number>();  // 도매 전용: 단기(windowDays) 창
  const shortFrom = dateAt(today, -windowDays);
  let oldest = today;
  let txCount = 0;
  for (const r of rows) {
    if (r.status != null && r.status !== "완료") continue; // 대기 출고 제외
    if (r.partner === "채널이동") continue;                 // 소매↔도매 이동은 판매/납품이 아님
    if (channel) {
      if ((r.channel ?? "소매") !== channel) continue;      // 채널 필터(036 미적용 행은 소매 취급)
      if (channel === "소매" && r.shipment_id != null) continue; // 소매 속도에서 B2B 발송 제외
      // 도매 속도는 B2B 발송 포함(납품 소진이 곧 도매 수요) — 단, 대량 발주 건은 제외(위)
      if (isWholesale && r.shipment_id != null && bulkShipments.has(r.shipment_id)) continue;
      if (isWholesale && r.txn_date && r.txn_date > today) continue; // 미래 컷 — 선점 출고의 미래분
    } else {
      if (r.shipment_id != null) continue;                  // 레거시: B2B 도매 출고 제외
    }
    const sku = r.products?.sku ? String(r.products.sku).toUpperCase() : null;
    if (!sku) continue;
    const q = Math.abs(Number(r.qty) || 0);
    if (!q) continue;
    totals.set(sku, (totals.get(sku) || 0) + q);
    if (isWholesale && r.txn_date && r.txn_date >= shortFrom) totalsShort.set(sku, (totalsShort.get(sku) || 0) + q);
    if (r.txn_date && r.txn_date < oldest) oldest = r.txn_date;
    txCount++;
  }
  const perSku: Record<string, number> = {};
  let spanDays: number;
  if (isWholesale) {
    // 분모 고정(기획 6절) — 원장이 창보다 짧으면 최초 거래일부터. spanDays 는 참고 표시용으로 단기 창 기준.
    const age = Math.max(1, daysBetween(oldest, today) || 1);
    const denShort = Math.min(windowDays, age);
    const denLong = Math.min(LONG_DAYS, age);
    for (const [sku, totalLong] of totals) {
      const short = (totalsShort.get(sku) || 0) / denShort;
      const long = totalLong / denLong;
      perSku[sku] = Math.max(short, long);
    }
    spanDays = denShort;
  } else {
    spanDays = Math.min(windowDays, Math.max(1, daysBetween(oldest, today) || 1));
    for (const [sku, total] of totals) perSku[sku] = total / spanDays;
  }

  return { computedAt: new Date().toISOString(), spanDays, txCount, capped: false, perSku };
}
