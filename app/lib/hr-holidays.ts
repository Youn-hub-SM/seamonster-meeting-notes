// 공휴일 — 화면과 서버가 같이 쓰는 타입·순수 함수. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  쉬는 날의 원천은 DB 의 hr.holidays 하나다(코드에는 날짜를 두지 않는다 — 임시공휴일·대체공휴일이 해마다 달라서).
//  이 목록이 하는 일은 둘뿐이다:
//   · 근무대장 [평소대로 채우기]가 그날을 '근무' 대신 '유급 휴일'로 채운다(소정근로일일 때만).
//   · 연차 [사용 등록]이 그날에는 연차를 넣지 않는다.
//  급여 계산은 지금까지와 같이 근무대장에 저장된 '유급 휴일' 줄만 본다 — 목록만 있고 줄이 없으면 급여에 들어가지 않는다.

export type Holiday = { date: string; name: string; seeded: boolean };

// 날짜가 해마다 같은 공휴일(월-일). [정해진 공휴일 넣기]가 그 해에 넣는다. 설·추석·부처님 오신 날·대체공휴일·선거일은 해마다 달라 직접 더한다.
export const FIXED_HOLIDAYS: [string, string][] = [
  ["01-01", "새해 첫날"], ["03-01", "삼일절"], ["05-01", "노동절"], ["05-05", "어린이날"], ["06-06", "현충일"],
  ["07-17", "제헌절"], ["08-15", "광복절"], ["10-03", "개천절"], ["10-09", "한글날"], ["12-25", "성탄절"],
];
export const fixedHolidaysOf = (year: number): { date: string; name: string }[] => FIXED_HOLIDAYS.map(([md, name]) => ({ date: `${year}-${md}`, name }));

// 그날이 그 사업장에서 유급으로 쉬는 날인가.
//  관공서 공휴일을 유급으로 줘야 하는 것은 상시 5인 이상 사업장이다. 노동절(5월 1일)은 사업장 크기와 상관없이 유급 휴일이다.
export const isPaidHoliday = (date: string, fivePlus: boolean): boolean => fivePlus || date.slice(5) === "05-01";

export const HOLIDAY_NAME_MAX = 40;
export const isYear = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100;
