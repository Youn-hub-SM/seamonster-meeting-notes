// 증명서·직인 — 서버 전용 조회. 화면에서 import 하지 말 것.

import { hrDb, isHrPending } from "./hr-db";
import type { PayResult } from "./hr-pay";
import type { WithholdingRow } from "./hr-docs";

export const HR_PENDING_005 = "DB 준비 전입니다. supabase/migrations/hr/005_stamps_links.sql 을 적용하세요.";

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

// 사업장 직인(data URL). 없으면 null. 표가 아직 없어도(hr/005 미적용) null — 증명서는 직인 없이 나온다.
export async function fetchStamp(workplaceId: string): Promise<{ image: string | null; pending: boolean }> {
  try {
    const { data, error } = await hrDb().from("workplace_stamps").select("image").eq("workplace_id", workplaceId).maybeSingle();
    if (error) throw error;
    return { image: (data as { image?: string } | null)?.image || null, pending: false };
  } catch (err) {
    if (isHrPending(err)) return { image: null, pending: true };
    throw err;
  }
}

// 그 직원의 확정한 급여(달별 급여액과 뗀 세금). from·to = YYYY-MM. 급여 표가 없으면 빈 목록.
export async function fetchWithholding(employeeId: string, from: string, to: string): Promise<WithholdingRow[]> {
  try {
    const { data, error } = await hrDb().from("payroll_lines")
      .select("result,payrolls!inner(month,pay_date,status)")
      .eq("employee_id", employeeId).eq("payrolls.status", "confirmed").gte("payrolls.month", from).lte("payrolls.month", to).limit(600);
    if (error) throw error;
    const out: WithholdingRow[] = [];
    for (const r of (data || []) as unknown as Row[]) {
      const p = (Array.isArray(r.payrolls) ? r.payrolls[0] : r.payrolls) as { month?: string; pay_date?: string } | null;
      const res = r.result as PayResult | null;
      if (!p?.month || !res || !Array.isArray(res.items)) continue;
      const amt = (code: string) => num(res.items.find((i) => i.code === code)?.amount);
      out.push({
        month: p.month, pay_date: String(p.pay_date || ""), pay_total: num(res.pay_total), exempt_total: num(res.exempt_total),
        taxable_total: num(res.taxable_total), income_tax: amt("income_tax"), local_tax: amt("local_tax"),
      });
    }
    return out.sort((a, b) => a.month.localeCompare(b.month));
  } catch (err) {
    if (isHrPending(err)) return [];
    throw err;
  }
}
