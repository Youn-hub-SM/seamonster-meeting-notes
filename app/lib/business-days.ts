// 영업일(주말·공휴일 제외) 계산 — 생산요청 '생산마감일' 기본값 등에 사용.
//  순수 함수(로컬 날짜 문자열 YYYY-MM-DD 기준, DB 미접근)라 클라이언트에서 바로 호출 가능.

// 대한민국 공휴일(대체공휴일 포함). ※ 매년 갱신 필요 — 마감일은 사용자가 수정 가능하므로 근사여도 무방.
export const KR_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01",                                                   // 신정
  "2026-02-16", "2026-02-17", "2026-02-18",                       // 설날 연휴
  "2026-03-01", "2026-03-02",                                     // 삼일절(일)+대체
  "2026-05-05",                                                   // 어린이날
  "2026-05-24", "2026-05-25",                                     // 부처님오신날(일)+대체
  "2026-06-06",                                                   // 현충일
  "2026-08-15", "2026-08-17",                                     // 광복절(토)+대체
  "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-28",         // 추석 연휴+대체
  "2026-10-03", "2026-10-05",                                     // 개천절(토)+대체
  "2026-10-09",                                                   // 한글날
  "2026-12-25",                                                   // 성탄절
  // 2027 (상반기 주요 — 연말 마감일이 넘어갈 수 있어 포함)
  "2027-01-01",                                                   // 신정
  "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",         // 설날 연휴+대체
  "2027-03-01",                                                   // 삼일절
  "2027-05-05",                                                   // 어린이날
]);

const isoOf = (dt: Date): string =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

/** 이 날짜가 영업일인가(주말·공휴일 아님). */
export function isBusinessDay(iso: string, holidays: Set<string> = KR_HOLIDAYS): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=일, 6=토
  return dow !== 0 && dow !== 6 && !holidays.has(iso);
}

/** fromIso(그날 자체는 세지 않음) 기준으로 영업일 n개 뒤 날짜(YYYY-MM-DD)를 반환. */
export function addBusinessDays(fromIso: string, n: number, holidays: Set<string> = KR_HOLIDAYS): string {
  const [y, m, d] = fromIso.split("-").map(Number);
  const dt = new Date(y, m - 1, d); // 로컬 자정
  let added = 0;
  while (added < n) {
    dt.setDate(dt.getDate() + 1);
    const dow = dt.getDay();
    if (dow === 0 || dow === 6) continue;      // 주말 제외
    if (holidays.has(isoOf(dt))) continue;     // 공휴일 제외
    added++;
  }
  return isoOf(dt);
}
