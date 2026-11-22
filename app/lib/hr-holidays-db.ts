// 공휴일 — 서버 전용 조회. 화면에서 import 하지 말 것.

import { hrDb, isHrPending } from "./hr-db";
import type { Holiday } from "./hr-holidays";

export const HR_PENDING_007 = "DB 준비 전입니다. supabase/migrations/hr/007_holidays.sql 을 적용하세요.";

type Row = Record<string, unknown>;

// 기간의 쉬는 날. 표가 아직 없으면(hr/007 미적용) 빈 목록 — 근무대장은 지금까지처럼 돈다.
export async function fetchHolidays(from: string, to: string): Promise<{ list: Holiday[]; pending: boolean }> {
  try {
    const { data, error } = await hrDb().from("holidays").select("holiday_date,name,seeded").gte("holiday_date", from).lte("holiday_date", to).order("holiday_date").limit(1000);
    if (error) throw error;
    return { pending: false, list: ((data || []) as unknown as Row[]).map((r) => ({ date: String(r.holiday_date), name: String(r.name ?? ""), seeded: !!r.seeded })) };
  } catch (err) {
    if (isHrPending(err)) return { list: [], pending: true };
    throw err;
  }
}

// 날짜 → 이름
export async function holidayNames(from: string, to: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const h of (await fetchHolidays(from, to)).list) out[h.date] = h.name || "공휴일";
  return out;
}
