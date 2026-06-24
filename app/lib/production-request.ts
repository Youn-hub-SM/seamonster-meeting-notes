import { supabaseAdmin } from "./supabase";
import { getManualProductions } from "./production-manual";

// ─────────────────────────────────────────────
// 생산요청서 — 제조사에 보낼 "이 기간에 이 품목 몇 개 생산" 집계.
//  생산예정일(production_date / 수동 productionDate) 기준으로 일/주/월 범위 집계.
// ─────────────────────────────────────────────

export type Period = "day" | "week" | "month";

export interface RequestRow {
  name: string;
  spec: string;
  qty: number;
  manual: boolean;
}

function iso(d: Date) { return d.toISOString().slice(0, 10); }

export function periodRange(period: Period, date: string): { from: string; to: string; label: string } {
  const d = new Date(date + "T00:00:00Z");
  if (period === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // 월=0 … 일=6
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    return { from: iso(mon), to: iso(sun), label: `주간 (${iso(mon)} ~ ${iso(sun)})` };
  }
  if (period === "month") {
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { from: iso(first), to: iso(last), label: `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월` };
  }
  return { from: date, to: date, label: `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일` };
}

export async function getRequestRows(period: Period, date: string): Promise<{ from: string; to: string; label: string; rows: RequestRow[]; total: number }> {
  const { from, to, label } = periodRange(period, date);
  const sb = supabaseAdmin();

  // B2B 발주(생산대기·생산중) 중 생산예정일이 기간 내인 라인아이템
  const { data: orders, error } = await sb
    .from("orders")
    .select("production_date, production_status, order_items(product_name, spec, qty)")
    .in("production_status", ["생산대기", "생산중"])
    .gte("production_date", from)
    .lte("production_date", to);
  if (error) throw error;

  const map = new Map<string, RequestRow>();
  type OItem = { product_name: string; spec: string | null; qty: number };
  for (const o of (orders ?? []) as unknown as { order_items: OItem[] }[]) {
    for (const it of o.order_items ?? []) {
      const spec = (it.spec || "").trim();
      const k = `${it.product_name}|${spec}`;
      const cur = map.get(k) || { name: it.product_name, spec, qty: 0, manual: false };
      cur.qty += Number(it.qty) || 0;
      map.set(k, cur);
    }
  }

  // 수동 생산일정 (해당 기간)
  const manual = await getManualProductions();
  for (const m of manual) {
    if (!m.productionDate || m.productionDate < from || m.productionDate > to) continue;
    const k = `${m.name}|`;
    const cur = map.get(k) || { name: m.name, spec: "", qty: 0, manual: true };
    cur.qty += m.qty;
    cur.manual = true;
    map.set(k, cur);
  }

  const rows = [...map.values()]
    .filter((r) => r.qty > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "ko") || a.spec.localeCompare(b.spec, "ko"));
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return { from, to, label, rows, total };
}
