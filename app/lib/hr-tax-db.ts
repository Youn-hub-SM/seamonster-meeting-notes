// 원천세 집계 — 서버 전용 조회. 화면에서 import 하지 말 것. 읽기만 한다(저장하는 것이 없다).

import { hrDb } from "./hr-db";
import { taxRows, type TaxBundle, type TaxHead, type TaxLine } from "./hr-tax";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const PAGE = 1000;

// 그 해에 지급한 급여 전부(사업장 구분 없이 — 화면이 사업장으로 좁힌다). 직원 이름·개인 금액은 싣지 않고 급여마다의 합계만 준다.
export async function loadTax(year: number): Promise<TaxBundle> {
  const [wps, heads] = await Promise.all([
    hrDb().from("workplaces").select("id,name").order("sort").order("created_at"),
    hrDb().from("payrolls").select("id,workplace_id,month,pay_date,status").gte("pay_date", `${year}-01-01`).lte("pay_date", `${year}-12-31`).order("pay_date").limit(2000),
  ]);
  if (wps.error) throw wps.error;
  if (heads.error) throw heads.error;
  const hs: TaxHead[] = ((heads.data || []) as unknown as Row[]).map((h) => ({
    id: String(h.id), workplace_id: String(h.workplace_id), month: String(h.month), pay_date: String(h.pay_date), status: h.status === "confirmed" ? "confirmed" : "draft",
  }));
  const lines: TaxLine[] = [];
  const ids = hs.map((h) => h.id);
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    // PostgREST 는 한 번에 1000줄까지만 주므로 끝까지 이어 읽는다 — 중간에 끊긴 채 더하면 세액이 틀린다
    for (let offset = 0; ; offset += PAGE) {
      const l = await hrDb().from("payroll_lines").select("payroll_id,employee_id,pay_total,exempt_total:result->exempt_total,taxable_total:result->taxable_total,items:result->items")
        .in("payroll_id", part).order("payroll_id").order("employee_id").range(offset, offset + PAGE - 1);
      if (l.error) throw l.error;
      const rows = (l.data || []) as unknown as Row[];
      for (const r of rows) {
        const items = Array.isArray(r.items) ? (r.items as { code?: unknown; amount?: unknown }[]) : [];
        const amt = (code: string) => num(items.find((x) => x.code === code)?.amount);
        lines.push({ payroll_id: String(r.payroll_id), pay_total: num(r.pay_total), exempt_total: num(r.exempt_total), taxable_total: num(r.taxable_total), income_tax: amt("income_tax"), local_tax: amt("local_tax") });
      }
      if (rows.length < PAGE) break;
    }
  }
  const workplaces = ((wps.data || []) as unknown as Row[]).map((w) => ({ id: String(w.id), name: String(w.name ?? "") }));
  return { year, workplaces, rows: taxRows(hs, lines, workplaces.map((w) => w.id)) };
}
