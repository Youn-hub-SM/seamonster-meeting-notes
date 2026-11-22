// 쉬는 날(공휴일·휴무일) — 서버 전용 조회. 화면에서 import 하지 말 것.

import { hrDb, isHrPending } from "./hr-db";
import { missingAffiliation } from "./hr-employees";
import { dayOffsOf, isHolidayKind, type DayOff, type Holiday, type HolidayWorkplace } from "./hr-holidays";

export const HR_PENDING_007 = "DB 준비 전입니다. supabase/migrations/hr/007_holidays.sql 을 적용하세요.";
export const HR_PENDING_008 = "DB 준비 전입니다. supabase/migrations/hr/008_holiday_kinds.sql 을 적용하세요.";

type Row = Record<string, unknown>;
type DbErr = { message?: string; code?: string } | null;
const COLS_007 = "holiday_date,name,seeded";
const COLS_008 = `id,${COLS_007},kind,workplace_id,affiliation`;

// '구분·적용 범위 칸이 없다'(hr/008 미적용)는 오류인가 — 표는 있는데 칸만 없는 경우
export function missingHolidayCols(err: unknown): boolean {
  const m = String((err as DbErr)?.message ?? "");
  return /(\bid\b|kind|workplace_id|affiliation)/i.test(m) && /(does not exist|schema cache|Could not find)/i.test(m) && !/relation/i.test(m);
}

const toHoliday = (r: Row): Holiday => ({
  // hr/008 전의 줄은 id 가 없다 — 날짜 하나에 한 줄이라 날짜를 id 로 쓴다
  id: String(r.id ?? r.holiday_date), date: String(r.holiday_date), name: String(r.name ?? ""),
  kind: isHolidayKind(r.kind) ? r.kind : "public", workplace_id: r.workplace_id ? String(r.workplace_id) : null,
  affiliation: String(r.affiliation ?? ""), seeded: !!r.seeded,
});

// 기간의 쉬는 날(날짜 순, 같은 날은 넓은 범위부터).
//  pending  = 표가 아직 없다(hr/007 미적용) — 빈 목록. 근무대장은 지금까지처럼 돈다.
//  extended = 구분·적용 범위 칸이 있다(hr/008 적용). 없으면 모든 줄을 공휴일·전체로 읽는다.
export async function fetchHolidays(from: string, to: string): Promise<{ list: Holiday[]; pending: boolean; extended: boolean }> {
  const run = (cols: string) => hrDb().from("holidays").select(cols).gte("holiday_date", from).lte("holiday_date", to).order("holiday_date").limit(2000);
  try {
    let extended = true;
    let res: { data: unknown; error: DbErr } = await run(COLS_008);
    if (res.error && missingHolidayCols(res.error)) { extended = false; res = await run(COLS_007); }
    if (res.error) throw res.error;
    const rank = (h: Holiday) => (h.workplace_id ? (h.affiliation ? 2 : 1) : 0);
    const list = ((res.data || []) as unknown as Row[]).map(toHoliday)
      .sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.affiliation.localeCompare(b.affiliation));
    return { pending: false, extended, list };
  } catch (err) {
    if (isHrPending(err) && !missingHolidayCols(err)) return { list: [], pending: true, extended: false };
    throw err;
  }
}

// 한 직원에게 걸리는 쉬는 날(날짜 → 이름·구분). 소속을 가리는 줄이 있을 때만 그 직원의 소속을 읽는다.
//  affiliation 을 이미 알면 넘긴다(근무대장). 모르면(연차) 직원 표에서 읽는다 — 소속 칸(hr/006)이 없으면 빈 값.
export async function dayOffsFor(from: string, to: string, employee: { id: string; workplace_id: string; affiliation?: string }): Promise<Record<string, DayOff>> {
  const { list } = await fetchHolidays(from, to);
  if (list.length === 0) return {};
  let affiliation = employee.affiliation;
  if (affiliation === undefined) {
    affiliation = "";
    if (list.some((h) => h.affiliation)) {
      const { data, error } = await hrDb().from("employees").select("affiliation").eq("id", employee.id).maybeSingle();
      if (error) { if (!missingAffiliation(error)) throw error; }
      else affiliation = String((data as Row | null)?.affiliation ?? "");
    }
  }
  return dayOffsOf(list, employee.workplace_id, affiliation);
}

// 적용 범위를 고를 사업장과 그 소속 목록. 소속 칸(hr/006)이 없으면 소속 없이.
export async function fetchHolidayWorkplaces(): Promise<HolidayWorkplace[]> {
  const run = (cols: string) => hrDb().from("workplaces").select(cols).order("sort").order("created_at");
  let res: { data: unknown; error: DbErr } = await run("id,name,affiliations");
  if (res.error && missingAffiliation(res.error)) res = await run("id,name");
  if (res.error) throw res.error;
  return ((res.data || []) as unknown as Row[]).map((r) => ({
    id: String(r.id), name: String(r.name ?? ""), affiliations: Array.isArray(r.affiliations) ? (r.affiliations as unknown[]).map(String) : [],
  }));
}
