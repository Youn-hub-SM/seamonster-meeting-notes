// 엑셀 올리기(인사대장·근무대장·급여대장) — 화면과 서버가 같이 쓰는 타입·순수 함수. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  올리는 양식 = 내려받는 양식이다. [엑셀 내려받기]로 받은 파일을 고쳐 그대로 올릴 수 있다(칸 이름으로 찾으므로 순서·빠진 칸은 상관없다).
//   · 인사대장: 한 줄 = 한 사람. 주민등록번호·사번·(성명+입사일)로 이미 있는 직원을 찾아 고치고, 없으면 새로 등록한다.
//       빈 칸은 건드리지 않는다(지우려면 화면에서). 가려진 번호(900101-1******)도 건드리지 않는다.
//   · 근무대장: 한 줄 = 한 사람의 하루. 직원마다 한 시트(내려받은 모양)이거나, 한 시트에 사번·성명 칸이 있는 목록이거나.
//       파일에 있는 날짜만 넣거나 고친다 — 파일에 없는 날·내용이 빈 줄은 건드리지 않는다(지우지 않는다).
//  읽은 내용의 검증·저장은 서버(app/lib/hr-import-db.ts)가 화면 입력과 같은 함수로 한다.

import { EMP_TYPES, WEEKDAYS, isDate, numText, rrnDigits } from "./hr";
import { WORK_KIND_LABEL, type WorkKind, type WorkLog } from "./hr-work";
import { SYSTEM_DEDUCT, SYSTEM_LABEL, SYSTEM_PAY } from "./hr-pay";

export type Cell = string | number | boolean | Date | null;
export type Grid = Cell[][];                       // grid[i] = 엑셀의 i+1 번째 줄(빈 줄은 빈 배열)
export type Sheet = { name: string; grid: Grid };

// ── 화면이 받는 미리보기·결과(두 대장 공통) ─────────────────────────
export type ImportAction = "create" | "update" | "same" | "error";
export const IMPORT_ACTION_LABEL: Record<ImportAction, string> = { create: "새로", update: "고침", same: "같음", error: "오류" };
export type ImportLine = { at: string; who: string; action: ImportAction; notes: string[]; errors: string[]; warns: string[] };
export type ImportReport = {
  applied: boolean;                        // false = 미리보기, true = 등록까지 했다
  counts: Record<ImportAction, number>;    // 인사대장 = 사람 수, 근무대장 = 날짜 수(오류는 줄 수)
  lines: ImportLine[];
  notes: string[];                         // 파일 전체에 대한 안내
  failed: string[];                        // 등록하다 실패한 것(applied 일 때)
};

// ── 칸 읽기 ─────────────────────────────────────────────────────────
const isBlank = (v: Cell | undefined): boolean => v == null || (typeof v === "string" && v.trim() === "");
export function cellText(v: Cell | undefined): string {
  if (v == null) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v).trim();
}
// 머리 줄 비교용: 공백·괄호·기호를 뺀다("휴게(분)" = "휴게 분" = "휴게분")
export const normHead = (v: Cell | undefined): string => cellText(v).replace(/[\s·._\-()（）[\]%/~:]/g, "").toLowerCase();

// 날짜 칸 → "YYYY-MM-DD". 빈 칸 = "", 읽지 못하면 null
export function cellDate(v: Cell | undefined): string | null {
  if (isBlank(v)) return "";
  const ymd = (s: string) => { const d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; return isDate(d) ? d : null; };
  if (v instanceof Date) { const s = Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10); return isDate(s) ? s : null; }
  if (typeof v === "number") {
    if (Number.isInteger(v) && v >= 19000101 && v <= 21001231) return ymd(String(v));     // 20261103
    if (v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10); // 엑셀 날짜 일련번호
    return null;
  }
  if (typeof v === "boolean") return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return ymd(s);
  const m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*[.일]?$/.exec(s);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return isDate(d) ? d : null;
}

// 시각 칸 → "HH:MM". 빈 칸 = "", 읽지 못하면 null
export function cellTime(v: Cell | undefined): string | null {
  if (isBlank(v)) return "";
  const hm = (mins: number) => { const t = ((Math.round(mins) % 1440) + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : hm(v.getUTCHours() * 60 + v.getUTCMinutes() + (v.getUTCSeconds() >= 30 ? 1 : 0));
  if (typeof v === "number") {
    if (v >= 0 && v < 1) return hm(v * 1440);                                               // 엑셀 시각(하루의 비율)
    if (Number.isInteger(v) && v >= 1 && v <= 23) return hm(v * 60);                        // 9 → 09:00
    if (Number.isInteger(v) && v >= 100 && v <= 2359 && v % 100 < 60) return hm(Math.floor(v / 100) * 60 + (v % 100)); // 900 → 09:00
    return null;
  }
  if (typeof v === "boolean") return null;
  const s = String(v).trim();
  const a = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s) || /^(\d{2})(\d{2})$/.exec(s);
  const k = a ? null : /^(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분)?$/.exec(s);
  const h = a ? Number(a[1]) : k ? Number(k[1]) : NaN, mi = a ? Number(a[2]) : k ? Number(k[2] || 0) : NaN;
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? hm(h * 60 + mi) : null;
}

// 숫자 칸. 빈 칸 = null, 읽지 못하면 NaN
export function cellNum(v: Cell | undefined): number | null {
  if (isBlank(v)) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date || typeof v === "boolean") return NaN;
  const n = Number(String(v).replace(/[,\s원]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

const short = (v: Cell | undefined) => cellText(v).slice(0, 30);

// ── 인사대장 ────────────────────────────────────────────────────────
type EmpKind = "text" | "date" | "time" | "int" | "num" | "rrn" | "workplace" | "paytype" | "days" | "yn" | "taxrate" | "insbasis" | "leavebasis" | "skip";
export type EmpCol = { label: string; key: string; kind: EmpKind; alias?: string[] };
// 내려받는 인사대장의 칸과 같은 목록(export 가 이 순서로 쓴다). key = 저장할 때의 칸 이름.
export const EMP_XLSX_COLS: EmpCol[] = [
  { label: "사업장", key: "workplace", kind: "workplace" },
  { label: "소속", key: "affiliation", kind: "text" },   // 사업장의 소속 목록 가운데 하나(파도소리 · 엄마와 바다 …)
  { label: "사번", key: "emp_no", kind: "text" },
  { label: "성명", key: "name", kind: "text", alias: ["이름"] },
  { label: "주민등록번호", key: "rrn", kind: "rrn", alias: ["주민번호"] },
  { label: "생년월일", key: "", kind: "skip" },          // 주민등록번호에서 정한다
  { label: "성별", key: "", kind: "skip" },
  { label: "주소", key: "address", kind: "text" },
  { label: "연락처", key: "phone", kind: "text", alias: ["전화", "전화번호", "휴대폰"] },
  { label: "비상 연락처", key: "emergency", kind: "text" },
  { label: "입사일", key: "hire_date", kind: "date" },
  { label: "퇴사일", key: "leave_date", kind: "date" },
  { label: "퇴사 사유", key: "leave_reason", kind: "text" },
  { label: "부서", key: "dept", kind: "text" },
  { label: "직위", key: "position", kind: "text", alias: ["직급"] },
  { label: "업무", key: "job", kind: "text", alias: ["담당 업무"] },
  { label: "고용 형태", key: "emp_type", kind: "text" },
  { label: "계약 시작", key: "contract_start", kind: "date" },
  { label: "계약 종료", key: "contract_end", kind: "date" },
  { label: "급여 형태", key: "pay_type", kind: "paytype" },
  { label: "시급", key: "hourly_wage", kind: "int" },
  { label: "월급", key: "monthly_wage", kind: "int" },
  { label: "임금 적용 시작일", key: "wage_from", kind: "date" },
  { label: "소정근로 요일", key: "work_days", kind: "days" },
  { label: "출근", key: "work_start", kind: "time" },
  { label: "퇴근", key: "work_end", kind: "time" },
  { label: "휴게(분)", key: "break_min", kind: "int", alias: ["휴게"] },
  { label: "하루 시간", key: "daily_hours", kind: "num", alias: ["하루 소정근로시간"] },
  { label: "공제대상가족", key: "dependents", kind: "int", alias: ["공제대상가족 수"] },
  { label: "8~20세 자녀", key: "children", kind: "int", alias: ["8~20세 자녀 수"] },
  { label: "원천징수(%)", key: "tax_rate", kind: "taxrate", alias: ["원천징수 비율"] },
  { label: "국민연금", key: "ins_pension", kind: "yn" },
  { label: "건강보험", key: "ins_health", kind: "yn" },
  { label: "고용보험", key: "ins_employment", kind: "yn" },
  { label: "보험 기준", key: "ins_basis", kind: "insbasis", alias: ["국민연금·건강보험 기준"] },
  { label: "기준소득월액", key: "pension_base", kind: "int" },
  { label: "보수월액", key: "health_base", kind: "int" },
  { label: "은행", key: "bank", kind: "text" },
  { label: "계좌번호", key: "account_no", kind: "text" },
  { label: "예금주", key: "account_holder", kind: "text" },
  { label: "연차 기준", key: "leave_basis", kind: "leavebasis" },
  { label: "이력", key: "career", kind: "text" },
  { label: "메모", key: "memo", kind: "text" },
];
export const EMP_XLSX_LABELS = EMP_XLSX_COLS.map((c) => c.label);
// 저장 칸 이름 → 화면의 칸 이름(오류·바뀐 칸을 말할 때)
export const EMP_KEY_LABEL: Record<string, string> = {
  ...Object.fromEntries(EMP_XLSX_COLS.filter((c) => c.key).map((c) => [c.key, c.label])),
  workplace_id: "사업장",
};
export const INS_BASIS_TEXT = { notice: "공단 고지", actual: "그달 급여" } as const;
export const LEAVE_BASIS_TEXT = { "": "사업장 기본값", hire: "입사일 기준", fiscal: "회계연도 기준" } as const;

// "월·화·수" · "월화수목금" · "월~금" → [1,2,3,4,5]. 읽지 못하면 null
export function parseWorkDays(text: string): number[] | null {
  const s = text.replace(/\s/g, "");
  if (!s) return [];
  const idx = (ch: string) => (WEEKDAYS as readonly string[]).indexOf(ch) + 1;
  const range = /^([월화수목금토일])요?일?[~\-–]([월화수목금토일])요?일?$/.exec(s);
  if (range) {
    const a = idx(range[1]), b = idx(range[2]);
    if (a > b) return null;
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const rest = s.replace(/[·,./요일및]/g, "");
  const days = [...rest].map(idx);
  if (days.length === 0 || days.some((d) => d < 1)) return null;
  return [...new Set(days)].sort((x, y) => x - y);
}

export type EmpSheetRow = {
  line: number;                         // 엑셀 줄 번호
  values: Record<string, unknown>;      // 저장 칸 이름 → 값(빈 칸은 없다). workplace = 사업장 이름, rrn = 숫자 13자리
  rrn: "none" | "masked" | "full";
  errors: string[];
};
export type EmpSheet = { rows: EmpSheetRow[]; used: string[]; unknown: string[]; hits: number };

// 시트 한 장에서 인사대장을 읽는다. '성명'과 다른 칸 하나 이상이 있는 머리 줄을 찾지 못하면 null.
//  hits = 머리 줄에서 알아본 칸 수 — 시트가 여럿이면 가장 많이 맞은 시트를 쓴다(작성 방법 시트를 대장으로 읽지 않게).
export function readEmployeeSheet(grid: Grid): EmpSheet | null {
  const byHead = new Map<string, EmpCol>();
  for (const c of EMP_XLSX_COLS) for (const name of [c.label, ...(c.alias || [])]) byHead.set(normHead(name), c);
  let head = -1, best = 1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const row = grid[i] || [];
    const hit = row.filter((v) => byHead.has(normHead(v))).length;
    if (hit > best && row.some((v) => byHead.get(normHead(v))?.key === "name")) { best = hit; head = i; }
  }
  if (head < 0) return null;
  const cols: (EmpCol | null)[] = (grid[head] || []).map((v) => byHead.get(normHead(v)) || null);
  const unknown = (grid[head] || []).map((v, i) => (cols[i] || isBlank(v) ? "" : cellText(v))).filter(Boolean);
  const used = cols.filter((c): c is EmpCol => !!c && c.kind !== "skip").map((c) => c.label);

  const rows: EmpSheetRow[] = [];
  for (let i = head + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    if (!cols.some((c, j) => c && c.kind !== "skip" && !isBlank(row[j]))) continue; // 읽을 칸이 모두 빈 줄
    const out: EmpSheetRow = { line: i + 1, values: {}, rrn: "none", errors: [] };
    cols.forEach((c, j) => {
      const v = row[j];
      if (!c || c.kind === "skip" || isBlank(v)) return;
      const bad = (why: string) => out.errors.push(`${c.label}: ${why}(${short(v)})`);
      const t = cellText(v);
      switch (c.kind) {
        case "text": out.values[c.key] = t; break;
        case "workplace": out.values.workplace = t; break;
        case "date": { const d = cellDate(v); if (d == null) bad("날짜를 읽지 못했습니다"); else if (d) out.values[c.key] = d; break; }
        case "time": { const x = cellTime(v); if (x == null) bad("시각을 읽지 못했습니다"); else if (x) out.values[c.key] = x; break; }
        case "int": { const n = cellNum(v); if (n == null) break; if (!Number.isFinite(n) || !Number.isInteger(n)) bad("숫자가 아닙니다"); else out.values[c.key] = n; break; }
        case "num": { const n = cellNum(v); if (n == null) break; if (!Number.isFinite(n)) bad("숫자가 아닙니다"); else out.values[c.key] = n; break; }
        case "taxrate": { const n = cellNum(v); if (n !== 80 && n !== 100 && n !== 120) bad("80·100·120 가운데 하나"); else out.values[c.key] = n; break; }
        case "rrn": {
          if (t.includes("*")) { out.rrn = "masked"; break; }                     // 가려진 번호는 건드리지 않는다
          let d = rrnDigits(t);
          if (typeof v === "number" && d.length >= 11 && d.length < 13) d = d.padStart(13, "0"); // 숫자 칸이라 앞의 0 이 떨어진 번호
          if (d.length !== 13) out.errors.push("주민등록번호: 숫자 13자리가 아닙니다");
          else { out.values.rrn = d; out.rrn = "full"; }
          break;
        }
        case "paytype": {
          const k = t.replace(/\s/g, "");
          if (/^(시급|시급제|hourly)$/i.test(k)) out.values[c.key] = "hourly";
          else if (/^(월급|월급제|monthly)$/i.test(k)) out.values[c.key] = "monthly";
          else bad("시급 또는 월급");
          break;
        }
        case "days": { const d = parseWorkDays(t); if (!d || d.length === 0) bad("요일을 읽지 못했습니다"); else out.values[c.key] = d; break; }
        case "yn": {
          const k = t.replace(/\s/g, "").toLowerCase();
          if (/^(가입|o|y|yes|예|true|1)$/.test(k)) out.values[c.key] = true;
          else if (/^(제외|미가입|x|n|no|아니오|false|0)$/.test(k)) out.values[c.key] = false;
          else bad("가입 또는 제외");
          break;
        }
        case "insbasis": {
          const k = t.replace(/\s/g, "");
          if (/^(공단고지|고지)$/.test(k)) out.values[c.key] = "notice";
          else if (/^(그달급여|급여|실제)$/.test(k)) out.values[c.key] = "actual";
          else bad("공단 고지 또는 그달 급여");
          break;
        }
        case "leavebasis": {
          const k = t.replace(/\s/g, "");
          if (/^(입사일기준|입사일)$/.test(k)) out.values[c.key] = "hire";
          else if (/^(회계연도기준|회계연도)$/.test(k)) out.values[c.key] = "fiscal";
          else if (/^(사업장기본값|기본값|기본)/.test(k)) out.values[c.key] = "";
          else bad("입사일 기준 또는 회계연도 기준");
          break;
        }
      }
    });
    if (typeof out.values.emp_type === "string" && !(EMP_TYPES as readonly string[]).includes(out.values.emp_type)) {
      out.errors.push(`고용 형태: ${EMP_TYPES.join("·")} 가운데 하나(${String(out.values.emp_type).slice(0, 30)})`);
    }
    rows.push(out);
  }
  return { rows, used, unknown, hits: best };
}

// 출근·퇴근·휴게 → 하루 소정근로시간(직원 등록 창과 같은 계산)
export function dailyHoursOf(start: string, end: string, breakMin: number): number | null {
  const m = (s: string) => { const x = /^(\d{2}):(\d{2})$/.exec(s); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const a = m(start), b = m(end);
  if (a == null || b == null) return null;
  const span = (b > a ? b - a : b + 1440 - a) - (Number.isFinite(breakMin) ? breakMin : 0);
  return span > 0 ? Math.round((span / 60) * 100) / 100 : null;
}

// ── 근무대장 ────────────────────────────────────────────────────────
export type WorkRaw = { work_date: string; kind: WorkKind; start_time: string | null; end_time: string | null; break_min: number | null; hours: number; night_hours: number | null; leave_days: number; memo: string };
export type WorkRow = {
  sheet: string; line: number;
  emp_no: string; name: string;     // 누구의 줄인가(시트 머리 또는 그 줄의 사번·성명)
  date: string;                     // YYYY-MM-DD("" = 날짜를 읽지 못함)
  raw: WorkRaw | null;              // null = 내용이 없는 줄(건드리지 않는다). break_min·night_hours 의 null = 빈 칸
  error: string;                    // 줄을 읽다 생긴 오류("" = 없음)
};
const WORK_HEADS: Record<string, string[]> = {
  date: ["날짜", "일자", "근무일", "근무일자"],
  emp_no: ["사번"], name: ["성명", "이름"],
  kind: ["종류", "구분", "근무 종류"],
  start: ["출근", "출근 시각", "출근 시간"], end: ["퇴근", "퇴근 시각", "퇴근 시간"],
  brk: ["휴게(분)", "휴게", "휴게 시간(분)"],
  hours: ["근무 시간", "시간"], night: ["야간", "야간 시간"],
  leave: ["연차"], memo: ["비고", "메모"],
};
const KIND_BY_TEXT: [RegExp, WorkKind][] = [
  [/^(근무|출근|정상|정상근무)$/, "work"],
  [/^(휴일근무|휴일출근|특근)$/, "holiday_work"],
  [/^(유급휴일|공휴일)$/, "paid_holiday"],
  [/^(연차|휴가|연차휴가)$/, "leave"],
  [/^(결근)$/, "absent"],
  [/^(무급휴무|무급|휴무)$/, "unpaid"],
];
function leavePart(v: Cell | undefined): number | null {
  if (isBlank(v)) return 0;
  const t = cellText(v).replace(/\s/g, "");
  if (t === "연차" || t === "1") return 1;
  if (t === "반차" || t === "0.5") return 0.5;
  if (t === "반반차" || t === "0.25") return 0.25;
  if (t === "없음" || t === "0") return 0;
  const n = Number(t);
  if (Number.isFinite(n) && n > 0 && n <= 1) return Math.round(n * 10000) / 10000;   // 시간 단위 연차는 일수로 적혀 나온다(예: 0.375)
  return null;
}

// 시트 한 장에서 근무대장을 읽는다. '날짜' 칸이 있는 머리 줄이 없으면 null(요약 시트 등).
export function readWorkSheet(sheet: Sheet): WorkRow[] | null {
  const { grid } = sheet;
  const keyOf = new Map<string, string>();
  for (const [k, names] of Object.entries(WORK_HEADS)) for (const n of names) keyOf.set(normHead(n), k);
  let head = -1;
  for (let i = 0; i < Math.min(grid.length, 8) && head < 0; i++) if ((grid[i] || []).some((v) => keyOf.get(normHead(v)) === "date")) head = i;
  if (head < 0) return null;
  const col: Record<string, number> = {};
  (grid[head] || []).forEach((v, j) => { const k = keyOf.get(normHead(v)); if (k && col[k] == null) col[k] = j; });
  const perRow = col.emp_no != null || col.name != null;

  // 직원마다 한 시트인 모양: 머리 줄 위에서 사번·성명을 찾는다(내려받은 파일의 첫 줄 = 근무대장 YYYY-MM, , 사업장, 성명, 사번 N, …)
  let sheetNo = "", sheetName = "";
  if (!perRow) {
    for (let i = 0; i < head; i++) {
      const row = grid[i] || [];
      for (const v of row) { const m = /^사번\s*(\S.*)$/.exec(cellText(v)); if (m) sheetNo = m[1].trim(); }
      if (cellText(row[0]).startsWith("근무대장") && cellText(row[3])) sheetName = cellText(row[3]);
    }
    if (!sheetName && !sheetNo) sheetName = sheet.name.trim();
  }

  const at = (row: Cell[], k: string): Cell | undefined => (col[k] == null ? undefined : row[col[k]]);
  const out: WorkRow[] = [];
  let seen = false;
  for (let i = head + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const first = normHead(row[0]);
    if (first === "주" || first === "합계") break;                       // 내려받은 파일의 주별·합계 표
    if (row.every((v) => isBlank(v))) { if (!perRow && seen) break; continue; }
    const content = ["kind", "start", "end", "hours", "leave"].some((k) => !isBlank(at(row, k)));
    const base = { sheet: sheet.name, line: i + 1, emp_no: perRow ? cellText(at(row, "emp_no")) : sheetNo, name: perRow ? cellText(at(row, "name")) : sheetName };
    const date = cellDate(at(row, "date"));
    if (!date) {
      if (content) out.push({ ...base, date: "", raw: null, error: date === "" ? "날짜가 비어 있습니다" : `날짜를 읽지 못했습니다(${short(at(row, "date"))})` });
      continue;
    }
    seen = true;
    const fail = (error: string) => out.push({ ...base, date, raw: null, error });

    const start = cellTime(at(row, "start")), end = cellTime(at(row, "end"));
    if (start == null) { fail(`출근 시각을 읽지 못했습니다(${short(at(row, "start"))})`); continue; }
    if (end == null) { fail(`퇴근 시각을 읽지 못했습니다(${short(at(row, "end"))})`); continue; }
    const brk = cellNum(at(row, "brk")), hours = cellNum(at(row, "hours")), night = cellNum(at(row, "night"));
    if (Number.isNaN(brk)) { fail(`휴게(분)이 숫자가 아닙니다(${short(at(row, "brk"))})`); continue; }
    if (Number.isNaN(hours)) { fail(`근무 시간이 숫자가 아닙니다(${short(at(row, "hours"))})`); continue; }
    if (Number.isNaN(night)) { fail(`야간이 숫자가 아닙니다(${short(at(row, "night"))})`); continue; }
    let part = leavePart(at(row, "leave"));
    if (part == null) { fail(`연차는 연차·반차·반반차 가운데 하나(${short(at(row, "leave"))})`); continue; }

    const kindText = cellText(at(row, "kind")).replace(/\s/g, "");
    const worked = !!start || !!end || (hours || 0) > 0;
    let kind: WorkKind | null = null;
    if (!kindText) kind = worked ? "work" : part > 0 ? "leave" : null;
    else if (kindText === "반차" || kindText === "반반차") { kind = worked ? "work" : "leave"; if (part === 0) part = kindText === "반차" ? 0.5 : 0.25; }
    else {
      kind = KIND_BY_TEXT.find(([re]) => re.test(kindText))?.[1] || null;
      if (!kind) { fail(`종류는 ${Object.values(WORK_KIND_LABEL).join("·")} 가운데 하나(${kindText.slice(0, 30)})`); continue; }
    }
    if (!kind) { out.push({ ...base, date, raw: null, error: "" }); continue; }   // 날짜만 있고 내용이 없는 줄
    out.push({
      ...base, date, error: "",
      raw: { work_date: date, kind, start_time: start || null, end_time: end || null, break_min: brk, hours: hours || 0, night_hours: night, leave_days: part, memo: cellText(at(row, "memo")).slice(0, 200) },
    });
  }
  return out;
}

// 저장된 줄과 올린 줄이 같은가(같으면 다시 쓰지 않는다)
export function sameWorkLog(a: WorkLog, b: WorkLog): boolean {
  const n = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
  return a.kind === b.kind && (a.start_time || "") === (b.start_time || "") && (a.end_time || "") === (b.end_time || "")
    && n(a.break_min) === n(b.break_min) && n(a.hours) === n(b.hours) && n(a.night_hours) === n(b.night_hours)
    && n(a.leave_days) === n(b.leave_days) && (a.memo || "") === (b.memo || "");
}

// ── 급여대장 ────────────────────────────────────────────────────────
// 올리는 양식 = [급여] 화면의 [엑셀 내려받기] 파일(app/api/hr/payroll/export). 한 줄 = 한 사람의 그달 급여.
//  읽는 칸: 자동 항목 12가지(기본급 … 지방소득세), 직접 넣는 항목(이름이 같은 칸 — 새로 만든 열도 된다), 비고.
//  합계·실수령액·근무 시간·회사 부담은 읽지 않는다(자동 계산). 빈 칸은 건드리지 않는다(0 으로 만들려면 0 을 적는다).
//  무엇이 '고친 칸'인지는 서버(hr-import-db.ts)가 저장된 급여와 대조해 정한다 — 이 함수는 칸을 읽기만 한다.
const PAY_IGNORED = ["생년월일", "부서", "직위", "업무", "급여 형태", "시급·월급", "근무 일수", "근무 시간", "연장", "야간", "휴일 근무", "주휴 시간",
  "비과세", "과세 급여", "회사 국민연금", "회사 건강보험", "회사 장기요양", "회사 고용보험", "회사 산재보험"];
const PAY_TOTAL_COLS: [string, "pay" | "deduct" | "net"][] = [["지급 합계", "pay"], ["공제 합계", "deduct"], ["실수령액", "net"]];
export const PAY_TOTAL_LABEL = { pay: "지급 합계", deduct: "공제 합계", net: "실수령액" } as const;
const PAY_MAX_ROWS = 2000;

// 급여대장에서 자리가 정해진 칸 이름인가(직접 넣는 항목의 이름이 이것과 같으면 그 항목은 엑셀로 읽을 수 없다)
export function isPayFixedHead(name: string): boolean {
  const n = normHead(name);
  return ["사번", "성명", "입사일", "비고"].includes(n) || PAY_IGNORED.some((l) => normHead(l) === n) || PAY_TOTAL_COLS.some(([l]) => normHead(l) === n)
    || [...SYSTEM_PAY, ...SYSTEM_DEDUCT].some((c) => normHead(SYSTEM_LABEL[c]) === n);
}

export type PaySheetRow = {
  line: number; emp_no: string; name: string; hire: string;
  cells: Record<string, number>;                                   // 코드(자동 항목 = SystemCode, 직접 넣는 항목 = "x:<항목 id>") → 금액. 빈 칸은 없다
  totals: Partial<Record<"pay" | "deduct" | "net", number>>;       // 파일에 적힌 합계(읽지 않는다 — 다시 계산한 값과 다르면 알려 주려고)
  memo: string | null;                                             // null = 빈 칸(건드리지 않는다)
  errors: string[]; warns: string[];
};
export type PaySheet = {
  month: string; title: string; stamp: string;                     // 첫 줄의 귀속월 · 사업장 글 · 저장 시각("" = 없음)
  rows: PaySheetRow[];
  labels: Record<string, string>;                                  // 코드 → 파일의 칸 이름
  unknown: string[];                                               // 읽지 않은 칸(모르는 이름)
  dups: string[];                                                  // 두 번 나온 칸
};

// extras = 엑셀로 읽을 직접 넣는 항목(코드 "x:<id>" 와 이름). 급여대장 머리 줄(성명·기본급)이 없으면 null.
export function readPaySheet(grid: Grid, extras: { code: string; name: string }[]): PaySheet | null {
  let h = -1;
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    const heads = (grid[i] || []).map(normHead);
    if (heads.includes("성명") && heads.includes("기본급")) { h = i; break; }
  }
  if (h < 0) return null;

  // 머리 줄 위: "급여대장 YYYY-MM" · 그 두 칸 옆의 사업장 글 · "저장 <시각>"
  let month = "", title = "", stamp = "";
  for (let i = 0; i < h; i++) {
    const row = grid[i] || [];
    for (let j = 0; j < row.length; j++) {
      const t = cellText(row[j]);
      const m = /급여대장\s*(\d{4}-\d{2})/.exec(t);
      if (m && !month) { month = m[1]; title = cellText(row[j + 2]); }
      const s = /^저장\s+(\S+)$/.exec(t);
      if (s) stamp = s[1];
    }
  }

  const sys = new Map<string, string>([...SYSTEM_PAY, ...SYSTEM_DEDUCT].map((c) => [normHead(SYSTEM_LABEL[c]), c]));
  const ext = new Map(extras.map((x) => [normHead(x.name), x.code]));
  const ignored = new Set(PAY_IGNORED.map(normHead));
  const totalOf = new Map(PAY_TOTAL_COLS.map(([l, k]) => [normHead(l), k]));
  type Col = { j: number; kind: "id" | "amount" | "total" | "memo"; key: string; label: string };
  const cols: Col[] = [], seen = new Set<string>(), unknown: string[] = [], dups: string[] = [];
  const labels: Record<string, string> = {};
  (grid[h] || []).forEach((raw, j) => {
    const n = normHead(raw), label = cellText(raw);
    if (!n) return;
    let col: Col;
    if (n === "사번") col = { j, kind: "id", key: "emp_no", label };
    else if (n === "성명") col = { j, kind: "id", key: "name", label };
    else if (n === "입사일") col = { j, kind: "id", key: "hire", label };
    else if (n === "비고") col = { j, kind: "memo", key: "memo", label };
    else if (sys.has(n)) col = { j, kind: "amount", key: sys.get(n)!, label };
    else if (totalOf.has(n)) col = { j, kind: "total", key: totalOf.get(n)!, label };
    else if (ignored.has(n)) return;
    else if (ext.has(n)) col = { j, kind: "amount", key: ext.get(n)!, label };
    else { unknown.push(label.slice(0, 30)); return; }
    if (seen.has(col.key)) { dups.push(label.slice(0, 30)); return; }
    seen.add(col.key); cols.push(col);
    if (col.kind === "amount") labels[col.key] = label;
  });

  const rows: PaySheetRow[] = [];
  for (let i = h + 1; i < grid.length && rows.length < PAY_MAX_ROWS; i++) {
    const line = grid[i] || [];
    if (line.every(isBlank)) continue;
    const r: PaySheetRow = { line: i + 1, emp_no: "", name: "", hire: "", cells: {}, totals: {}, memo: null, errors: [], warns: [] };
    for (const c of cols) {
      const v = line[c.j];
      if (c.kind === "id") {
        if (c.key === "hire") r.hire = cellDate(v) || ""; else if (c.key === "emp_no") r.emp_no = cellText(v); else r.name = cellText(v);
      } else if (c.kind === "memo") {
        const t = cellText(v);
        if (t) r.memo = t.slice(0, 300);
      } else {
        const num = cellNum(v);
        if (num == null) continue;
        if (c.kind === "total") { if (Number.isFinite(num)) r.totals[c.key as "pay" | "deduct" | "net"] = Math.round(num); continue; }
        if (!Number.isFinite(num)) { r.errors.push(`${c.label}: 숫자가 아닙니다(${short(v)})`); continue; }
        const won = Math.round(num);
        if (Math.abs(won) > 1e9) { r.errors.push(`${c.label}: 금액이 너무 큽니다`); continue; }
        if (won !== num) r.warns.push(`${c.label}: 원 단위로 반올림했습니다(${numText(won)}원)`);
        r.cells[c.key] = won;
      }
    }
    if (r.emp_no === "합계" || (!r.emp_no && r.name === "합계")) continue;   // 맨 아래 합계 줄
    rows.push(r);
  }
  return { month, title, stamp, rows, labels, unknown, dups };
}
