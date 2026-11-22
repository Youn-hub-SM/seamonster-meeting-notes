// 쉬는 날(공휴일·휴무일) — 화면과 서버가 같이 쓰는 타입·순수 함수. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  쉬는 날의 원천은 DB 의 hr.holidays 하나다(코드에는 날짜를 두지 않는다 — 임시공휴일·대체공휴일·회사 휴무일이 해마다 달라서).
//  이 목록이 하는 일은 둘뿐이다:
//   · 근무대장 [평소대로 채우기]가 그날을 '근무' 대신 '유급 휴일' 또는 '무급 휴무'로 채운다(소정근로일일 때만).
//   · 연차 [사용 등록]이 그날에는 연차를 넣지 않는다.
//  급여 계산은 지금까지와 같이 근무대장에 저장된 줄만 본다 — 목록만 있고 줄이 없으면 급여에 들어가지 않는다.

// 구분(hr/008)
//   public = 공휴일(관공서 공휴일) — 상시 5인 이상 사업장만 유급 휴일. 5인 미만은 노동절만
//   paid   = 유급 휴무일(회사가 정한 유급 휴일) — 사업장 크기와 상관없이 유급 휴일
//   unpaid = 무급 휴무일 — 무급 휴무
export const HOLIDAY_KINDS = ["public", "paid", "unpaid"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];
export const HOLIDAY_KIND_LABEL: Record<HolidayKind, string> = { public: "공휴일", paid: "유급 휴무일", unpaid: "무급 휴무일" };
export const isHolidayKind = (v: unknown): v is HolidayKind => (HOLIDAY_KINDS as readonly string[]).includes(String(v));

// 적용 범위: workplace_id 가 비면 전체, 있으면 그 사업장, affiliation 까지 있으면 그 사업장의 그 소속
export type Holiday = { id: string; date: string; name: string; kind: HolidayKind; workplace_id: string | null; affiliation: string; seeded: boolean };
// 한 직원에게 그날 걸리는 쉬는 날
export type DayOff = { name: string; kind: HolidayKind };
export type HolidayWorkplace = { id: string; name: string; affiliations: string[] };

// 날짜가 해마다 같은 공휴일(월-일). [정해진 공휴일 넣기]가 그 해에 넣는다. 설·추석·부처님 오신 날·대체공휴일·선거일은 해마다 달라 직접 더한다.
export const FIXED_HOLIDAYS: [string, string][] = [
  ["01-01", "새해 첫날"], ["03-01", "삼일절"], ["05-01", "노동절"], ["05-05", "어린이날"], ["06-06", "현충일"],
  ["07-17", "제헌절"], ["08-15", "광복절"], ["10-03", "개천절"], ["10-09", "한글날"], ["12-25", "성탄절"],
];
export const fixedHolidaysOf = (year: number): { date: string; name: string }[] => FIXED_HOLIDAYS.map(([md, name]) => ({ date: `${year}-${md}`, name }));

// 그 공휴일이 그 사업장에서 유급으로 쉬는 날인가.
//  관공서 공휴일을 유급으로 줘야 하는 것은 상시 5인 이상 사업장이다. 노동절(5월 1일)은 사업장 크기와 상관없이 유급 휴일이다.
export const isPaidHoliday = (date: string, fivePlus: boolean): boolean => fivePlus || date.slice(5) === "05-01";

// 범위의 좁기: 소속(2) > 사업장(1) > 전체(0). 그 직원에게 걸리지 않는 줄은 -1
const scopeRank = (h: Holiday, workplaceId: string, affiliation: string): number => {
  if (!h.workplace_id) return h.affiliation ? -1 : 0;
  if (h.workplace_id !== workplaceId) return -1;
  if (!h.affiliation) return 1;
  return h.affiliation === affiliation ? 2 : -1;
};

// 한 직원(사업장·소속)에게 걸리는 쉬는 날(날짜 → 이름·구분). 같은 날에 줄이 여럿이면 범위가 좁은 줄이 이긴다.
export function dayOffsOf(list: Holiday[], workplaceId: string, affiliation: string): Record<string, DayOff> {
  const out: Record<string, DayOff> = {}, rank: Record<string, number> = {};
  for (const h of list) {
    const r = scopeRank(h, workplaceId, affiliation);
    if (r < 0 || (rank[h.date] ?? -1) >= r) continue;
    rank[h.date] = r;
    out[h.date] = { name: h.name || HOLIDAY_KIND_LABEL[h.kind], kind: h.kind };
  }
  return out;
}

// 그 쉬는 날을 근무대장에 어떤 종류로 채우나. null = 채우지 않는다(5인 미만 사업장의 공휴일 — 평소 근무일로 본다).
export function fillKindOf(off: DayOff | undefined, date: string, fivePlus: boolean): "paid_holiday" | "unpaid" | null {
  if (!off) return null;
  if (off.kind === "unpaid") return "unpaid";
  if (off.kind === "paid") return "paid_holiday";
  return isPaidHoliday(date, fivePlus) ? "paid_holiday" : null;
}

// 적용 범위를 글로. 사업장이 하나뿐이면 사업장 이름은 줄인다.
export function scopeText(h: Pick<Holiday, "workplace_id" | "affiliation">, workplaces: HolidayWorkplace[]): string {
  if (!h.workplace_id) return "전체";
  const w = workplaces.find((x) => x.id === h.workplace_id);
  const name = w?.name || "없는 사업장";
  if (!h.affiliation) return name;
  return workplaces.length > 1 ? `${name} · ${h.affiliation}` : h.affiliation;
}

export const HOLIDAY_NAME_MAX = 40;
export const isYear = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100;
