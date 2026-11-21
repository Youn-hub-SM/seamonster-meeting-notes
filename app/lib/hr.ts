// 급여·연차 창 — 화면과 서버가 같이 쓰는 타입·순수 함수. 비밀(키·DB)에 닿는 코드는 여기에 두지 않는다.

export type Workplace = {
  id: string; name: string; biz_no: string; ceo: string; address: string; phone: string;
  five_plus: boolean; week_start: number; weekly_pay_month: "end" | "start"; auto_weekly: boolean;
  payday: number; accident_rate: number; employ_extra_rate: number;
  fiscal_start: string; leave_basis: "hire" | "fiscal"; leave_round: "ceil_half" | "ceil_one" | "round_half" | "none";
  sort: number; active: boolean;
  affiliations: string[];    // 소속 이름 목록(한 회사 안의 사업 단위). hr/006 미적용이면 빈 목록
};

export type Wage = { id: string; effective_from: string; hourly_wage: number; monthly_wage: number; note: string };

export type Employee = {
  id: string; workplace_id: string; emp_no: string; name: string;
  affiliation: string;       // 소속(사업장의 소속 목록 가운데 하나. "" = 정하지 않음)
  rrn_masked: string; has_rrn: boolean; birth_date: string | null; gender: "" | "남" | "여"; foreigner: boolean;
  address: string; phone: string; emergency: string;
  hire_date: string; leave_date: string | null; leave_reason: string;
  dept: string; position: string; job: string; emp_type: string;
  contract_start: string | null; contract_end: string | null; career: string;
  pay_type: "hourly" | "monthly";
  work_days: number[]; work_start: string; work_end: string; break_min: number; daily_hours: number;
  dependents: number; children: number; tax_rate: 80 | 100 | 120;
  ins_pension: boolean; ins_health: boolean; ins_employment: boolean;
  ins_basis: "notice" | "actual"; pension_base: number; health_base: number;
  bank: string; account_no: string; account_holder: string;
  leave_basis: "" | "hire" | "fiscal"; memo: string;
  wages: Wage[];           // 적용 시작일 내림차순
  updated_at?: string;
};

export type Rate = {
  id: string; effective_from: string;
  pension_rate: number; pension_min: number; pension_max: number;
  health_rate: number; health_min_premium: number; health_max_premium: number;
  ltc_rate: number; employ_rate: number; employ_employer_rate: number;
  min_wage: number; child_credit_1: number; child_credit_2: number; child_credit_more: number;
  meal_limit: number; car_limit: number; childcare_limit: number;
  note: string; checked: boolean;
};

export const EMP_TYPES = ["정규직", "계약직", "단시간", "일용직", "기타"] as const;

// ── 소속 ────────────────────────────────────────────────────────────
// 소속 목록을 적은 글자("파도소리, 엄마와 바다" · 줄바꿈도 된다) → 이름 목록. 빈 이름·같은 이름은 뺀다.
export const AFFILIATION_MAX = 30;       // 한 사업장의 소속 수
export const AFFILIATION_NAME_MAX = 40;  // 소속 이름 길이
export function parseAffiliations(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map((x) => String(x ?? "")) : String(input ?? "").split(/[,\n]/);
  const out: string[] = [];
  for (const p of parts) { const name = p.replace(/\s+/g, " ").trim(); if (name && !out.includes(name)) out.push(name); }
  return out;
}
// 고를 수 있는 소속: 사업장의 목록 + (목록에는 없지만) 지금 값
export function affiliationOptions(list: string[] | undefined, current = ""): string[] {
  const base = list || [];
  return current && !base.includes(current) ? [...base, current] : base;
}
export const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const; // 1=월 … 7=일
export const PAY_TYPE_LABEL: Record<Employee["pay_type"], string> = { hourly: "시급", monthly: "월급" };
export const LEAVE_BASIS_LABEL: Record<"hire" | "fiscal", string> = { hire: "입사일 기준", fiscal: "회계연도 기준" };
export const LEAVE_ROUND_LABEL: Record<Workplace["leave_round"], string> = {
  ceil_half: "0.5일 단위 올림", ceil_one: "1일 단위 올림", round_half: "0.5일 단위 반올림", none: "그대로",
};

// ── 날짜 ────────────────────────────────────────────────────────────
// 오늘(KST) "YYYY-MM-DD"
export function todayKst(): string {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// 만 나이(기준일 on 에 생일이 지났는가까지)
export function ageOn(birth: string | null, on: string = todayKst()): number | null {
  if (!birth || !isDate(birth) || !isDate(on)) return null;
  let age = Number(on.slice(0, 4)) - Number(birth.slice(0, 4));
  if (on.slice(5) < birth.slice(5)) age--;
  return age;
}
// 재직 중인가(기준일에) — 퇴사일 당일까지 재직
export function isActiveOn(e: { hire_date: string; leave_date: string | null }, on: string = todayKst()): boolean {
  return e.hire_date <= on && (!e.leave_date || e.leave_date >= on);
}
// 근속 기간 "3년 2개월"
export function tenureText(hire: string, until: string = todayKst()): string {
  if (!isDate(hire) || !isDate(until) || until < hire) return "";
  let months = (Number(until.slice(0, 4)) - Number(hire.slice(0, 4))) * 12 + (Number(until.slice(5, 7)) - Number(hire.slice(5, 7)));
  if (until.slice(8) < hire.slice(8)) months--;
  const y = Math.floor(months / 12), m = months % 12;
  return y > 0 ? (m > 0 ? `${y}년 ${m}개월` : `${y}년`) : `${m}개월`;
}

// ── 주민등록번호 ────────────────────────────────────────────────────
// 형식만 다룬다(암호화는 서버 hr-crypto.ts). 입력은 하이픈 있든 없든 받는다.
export type RrnInfo = {
  digits: string;            // 숫자 13자리
  birth: string;             // YYYY-MM-DD
  gender: "남" | "여";
  foreigner: boolean;        // 외국인등록번호(뒷자리 첫 숫자 5~8)
  checksumOk: boolean;       // 검증 숫자 일치 — 2020-10 이후 발급 번호는 맞지 않을 수 있어 경고만 한다
};
export function rrnDigits(input: string): string {
  return String(input || "").replace(/\D/g, "");
}
// 맞으면 정보, 아니면 이유(문장)
export function parseRrn(input: string): { ok: true; info: RrnInfo } | { ok: false; error: string } {
  const d = rrnDigits(input);
  if (d.length !== 13) return { ok: false, error: "주민등록번호는 숫자 13자리입니다." };
  const g = Number(d[6]);
  const century = g === 1 || g === 2 || g === 5 || g === 6 ? 1900 : g === 3 || g === 4 || g === 7 || g === 8 ? 2000 : 1800;
  const birth = `${century + Number(d.slice(0, 2))}-${d.slice(2, 4)}-${d.slice(4, 6)}`;
  if (!isDate(birth)) return { ok: false, error: "주민등록번호 앞 6자리가 날짜가 아닙니다." };
  if (birth > todayKst()) return { ok: false, error: "주민등록번호의 생년월일이 오늘보다 뒤입니다." };
  const foreigner = g >= 5 && g <= 8;
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = weights.reduce((s, w, i) => s + w * Number(d[i]), 0);
  let check = (11 - (sum % 11)) % 10;
  if (foreigner) check = (check + 2) % 10;
  return { ok: true, info: { digits: d, birth, gender: g % 2 === 1 ? "남" : "여", foreigner, checksumOk: check === Number(d[12]) } };
}
// 화면 표시용: 900101-1******
export function maskRrn(digits: string): string {
  const d = rrnDigits(digits);
  return d.length === 13 ? `${d.slice(0, 6)}-${d[6]}******` : "";
}
// 전체 표기: 900101-1234567
export function formatRrn(digits: string): string {
  const d = rrnDigits(digits);
  return d.length === 13 ? `${d.slice(0, 6)}-${d.slice(6)}` : d;
}
// 입력 중 자동 하이픈(숫자 13자리까지만)
export function typeRrn(input: string): string {
  const d = rrnDigits(input).slice(0, 13);
  return d.length > 6 ? `${d.slice(0, 6)}-${d.slice(6)}` : d;
}

// ── 임금 ────────────────────────────────────────────────────────────
// 그 날짜에 유효한 임금 줄(적용 시작일이 그날 이전인 것 중 가장 늦은 것). 없으면 null.
export function wageOn(wages: Wage[], on: string = todayKst()): Wage | null {
  let hit: Wage | null = null;
  for (const w of wages) if (w.effective_from <= on && (!hit || w.effective_from > hit.effective_from)) hit = w;
  return hit;
}
// 목록에 보일 "지금 임금": 오늘 유효한 줄, 아직 시작 전이면 가장 이른 줄
export function currentWage(wages: Wage[]): Wage | null {
  if (wages.length === 0) return null;
  return wageOn(wages) || [...wages].sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
}

// 목록·카드에 보일 임금 한 줄: "시급 10,320원"
export function wageText(e: Pick<Employee, "pay_type" | "wages">): string {
  const w = currentWage(e.wages);
  if (!w) return "";
  return e.pay_type === "hourly" ? `시급 ${numText(w.hourly_wage)}원` : `월급 ${numText(w.monthly_wage)}원`;
}

// ── 요율 ────────────────────────────────────────────────────────────
// 그 날짜에 유효한 요율 줄. 4대보험·최저임금은 귀속월의 1일로, 소득세 자녀 공제는 지급일로 찾는다.
export function rateOn<T extends { effective_from: string }>(rates: T[], on: string): T | null {
  let hit: T | null = null;
  for (const r of rates) if (r.effective_from <= on && (!hit || r.effective_from > hit.effective_from)) hit = r;
  return hit;
}

export const numText = (n: number | null | undefined): string => (n == null ? "" : Math.round(n).toLocaleString("ko-KR"));
// 소수 요율 표기: 뒤의 0 을 지운다(9.5000 → 9.5)
export const rateText = (n: number | null | undefined): string => (n == null ? "" : String(Number(n)));
export const workDaysText = (days: number[]): string => [...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d - 1]).filter(Boolean).join("·");
