import { supabaseAdmin } from "./supabase";
import { getManualProductions } from "./production-manual";
import { loadProdItemMaps } from "./production-items";
import { loadRequests } from "./wholesale-production-db";
import { LINK_B2B_ORDERS_TO_PRODUCTION } from "./production-config";

// ─────────────────────────────────────────────
// 생산요청서 — 제조사에 보낼 "이 기간에 이 품목 몇 개 생산" 집계.
//  수동 일정=생산일, 도매 생산요청=생산마감일 기준. (B2B 발주 연동은 LINK_B2B_ORDERS_TO_PRODUCTION 로 게이팅)
// ─────────────────────────────────────────────

export const PERIOD_DAYS = [1, 7, 14, 30] as const;

export interface RequestRow {
  name: string;
  spec: string;
  qty: number;
  manual: boolean;
  wholesale: boolean; // 도매 생산요청분 포함 여부(비고 표시용)
}

function iso(d: Date) { return d.toISOString().slice(0, 10); }

// 선택일(date)부터 N일 범위.
export function periodRange(days: number, date: string): { from: string; to: string; label: string } {
  const d = new Date(date + "T00:00:00Z");
  const end = new Date(d); end.setUTCDate(d.getUTCDate() + Math.max(1, days) - 1);
  if (days <= 1) return { from: date, to: date, label: `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (당일)` };
  return { from: date, to: iso(end), label: `${days}일 (${date} ~ ${iso(end)})` };
}

export async function getRequestRows(days: number, date: string): Promise<{ from: string; to: string; label: string; rows: RequestRow[]; total: number }> {
  const { from, to, label } = periodRange(days, date);
  const sb = supabaseAdmin();

  // B2B 발주(생산대기·생산중) 중 생산예정일이 기간 내인 라인아이템 + SKU 매핑.
  //  재고 생산을 별도 운영하면(플래그 off) B2B 발주는 집계에서 제외 — 빈 조회로 대체.
  const [{ data: orders, error }, maps] = await Promise.all([
    LINK_B2B_ORDERS_TO_PRODUCTION
      ? sb.from("orders")
          .select("production_date, production_status, order_items(product_id, product_name, spec, qty)")
          .in("production_status", ["생산대기", "생산중"])
          .gte("production_date", from)
          .lte("production_date", to)
      : Promise.resolve({ data: [], error: null }),
    loadProdItemMaps(),
  ]);
  if (error) throw error;

  // SKU 로 묶음 (같은 제품 = 같은 SKU, B2B 품목명 달라도). SKU 없으면 품목명+규격.
  const map = new Map<string, RequestRow>();
  type OItem = { product_id: string | null; product_name: string; spec: string | null; qty: number };
  for (const o of (orders ?? []) as unknown as { order_items: OItem[] }[]) {
    for (const it of o.order_items ?? []) {
      const spec = (it.spec || "").trim();
      const sku = it.product_id ? maps.skuByProduct.get(it.product_id) || null : null;
      const k = sku || `${it.product_name}|${spec}`;
      const name = sku ? maps.displayBySku.get(sku) || it.product_name : it.product_name;
      const cur = map.get(k) || { name, spec, qty: 0, manual: false, wholesale: false };
      cur.qty += Number(it.qty) || 0;
      map.set(k, cur);
    }
  }

  // 수동 생산일정 (해당 기간)
  const manual = await getManualProductions();
  for (const m of manual) {
    if (!m.productionDate || m.productionDate < from || m.productionDate > to) continue;
    const sku = (m.sku || "").toUpperCase() || null;
    const k = sku || `${m.name}|`;
    const name = sku ? maps.displayBySku.get(sku) || m.name : m.name;
    const cur = map.get(k) || { name, spec: "", qty: 0, manual: true, wholesale: false };
    cur.qty += m.qty;
    cur.manual = true;
    map.set(k, cur);
  }

  // 도매 생산요청(요청·진행중) — 생산마감일(없는 옛 데이터는 요청일) 기준, 남은 수량(요청-입고)만.
  //  생산 일정 화면과 같은 축·같은 수량 규칙.
  const wholesaleReqs = await loadRequests(sb);
  for (const req of wholesaleReqs) {
    if (req.status !== "요청" && req.status !== "진행중") continue;
    const sched = req.due_date || req.request_date;
    if (!sched || sched < from || sched > to) continue;
    for (const it of req.items) {
      const remaining = it.requested_qty - it.received_qty;
      if (remaining <= 0) continue;
      const sku = it.product_id ? maps.skuByProduct.get(it.product_id) || null : null;
      const spec = (it.spec || "").trim();
      const k = sku || `${it.name}|${spec}`;
      const name = sku ? maps.displayBySku.get(sku) || it.name : it.name;
      const cur = map.get(k) || { name, spec, qty: 0, manual: false, wholesale: true };
      cur.qty += remaining;
      cur.wholesale = true;
      map.set(k, cur);
    }
  }

  const rows = [...map.values()]
    .filter((r) => r.qty > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "ko") || a.spec.localeCompare(b.spec, "ko"));
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return { from, to, label, rows, total };
}
