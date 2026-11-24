// 급여 이체 파일(국민은행 급여이체 엑셀) — 화면과 서버가 같이 쓰는 타입·순수 규칙. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  양식(2026-11-24 대표가 준 실물 '급여이체' 시트): 머리 줄 없이 1줄부터 한 사람 한 줄.
//   A 은행명 또는 은행코드(글자) · B 입금계좌번호(글자, '-' 생략) · C 이체금액(숫자) · D 예금주성명(띄어쓰기 없이)
//   E 받는분 통장표시("급여") · F 내 통장 메모(선택) · G 메모(선택)
//  양식 오른쪽(I~V열)의 '유의사항'과 '주요 은행' 코드 표도 양식 그대로 넣는다(2026-11-24 대표: "우측 코드는 그대로 살려줘. 간혹 틀리는 경우도 있어")
//   — 은행 이름이 틀리게 들어간 줄을 그 표를 보고 손으로 고치려는 것. 은행은 등록 전에 유의사항을 지우라고 하므로 올리기 전에 지운다.
//  은행 이름은 양식 아래 '주요 은행' 표의 이름으로 바꿔 적는다(직원 정보에 "국민은행"·"KB"처럼 적혀 있어도 "국민").
//   표에 없는 이름은 적힌 그대로 내보내고 확인하라고 알린다 — 은행 화면에서 걸러진다.
//  금액 = 저장한 급여의 실수령액. 0원 이하는 이체할 것이 없어 고를 수 없다.

// 양식의 '주요 은행' 표(이름 → 코드)
export const KB_BANKS: Record<string, string> = {
  국민: "004", 경남: "039", 광주: "034", 기업: "003", 농협: "011", 아이엠뱅크: "031", 부산: "032",
  산업: "002", 저축: "050", 새마을금고: "045", 수협: "007", 신한: "088", 신협: "048", 씨티: "027",
  KEB하나: "081", 우리: "020", 우체국: "071", 전북: "037", SC: "023", 제주: "035", HSBC: "054",
  케이뱅크: "089", 카카오뱅크: "090", 토스뱅크: "092",
};
// 사람들이 흔히 적는 이름 → 양식의 이름(공백·'은행'·대소문자를 뗀 뒤 견준다)
const ALIASES: Record<string, string[]> = {
  국민: ["국민", "kb", "kb국민", "국민kb"], 경남: ["경남", "bnk경남"], 광주: ["광주"], 기업: ["기업", "ibk", "ibk기업", "중소기업"],
  농협: ["농협", "nh", "nh농협", "농협중앙회", "단위농협", "지역농협", "농축협", "축협"], 아이엠뱅크: ["아이엠뱅크", "아이엠", "im뱅크", "im", "대구", "dgb", "dgb대구"],
  부산: ["부산", "bnk부산"], 산업: ["산업", "kdb", "kdb산업"], 저축: ["저축", "상호저축", "sb저축"], 새마을금고: ["새마을금고", "새마을", "mg", "mg새마을금고"],
  수협: ["수협", "sh수협", "수협중앙회"], 신한: ["신한"], 신협: ["신협", "신용협동조합"], 씨티: ["씨티", "시티", "citi", "한국씨티"],
  KEB하나: ["keb하나", "하나", "keb", "외환", "하나keb"], 우리: ["우리"], 우체국: ["우체국"], 전북: ["전북", "jb전북"],
  SC: ["sc", "sc제일", "제일", "스탠다드차타드"], 제주: ["제주"], HSBC: ["hsbc"],
  케이뱅크: ["케이뱅크", "케이", "k뱅크", "kbank"], 카카오뱅크: ["카카오뱅크", "카카오", "카뱅", "kakaobank"], 토스뱅크: ["토스뱅크", "토스", "tossbank"],
};
const BY_ALIAS = new Map<string, string>();
for (const [name, list] of Object.entries(ALIASES)) for (const a of list) BY_ALIAS.set(a, name);
const squash = (s: string) => s.replace(/[\s()·.\-_]/g, "").toLowerCase();

// 직원 정보의 은행 글 → 양식의 은행 이름. 모르는 이름이면 ""(코드 세 자리를 적어 둔 경우는 그 코드 그대로)
export function kbBankName(text: string): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/^\d{3}$/.test(raw)) return raw;
  const k = squash(raw);
  return BY_ALIAS.get(k) || BY_ALIAS.get(k.replace(/은행$/, "")) || BY_ALIAS.get(k.replace(/뱅크$/, "")) || "";
}
// 계좌번호 → 숫자만('-'·공백을 뗀다). 숫자가 아닌 글자가 섞여 있으면 ""
export function accountDigits(text: string): string {
  const t = String(text || "").replace(/[\s-]/g, "");
  return /^\d{6,20}$/.test(t) ? t : "";
}
// 끝 네 자리만 보이게(화면 목록용)
export const maskAccount = (digits: string): string => (digits.length > 4 ? `${"*".repeat(digits.length - 4)}${digits.slice(-4)}` : digits);

export type BankSource = { employee_id: string; name: string; affiliation: string; bank: string; account_no: string; account_holder: string; net_pay: number };
// 화면 목록의 한 줄. 계좌번호 전체는 싣지 않는다(끝 네 자리만) — 전체는 내려받는 파일에만 들어간다.
export type BankRow = {
  employee_id: string; name: string; affiliation: string;
  bank: string;            // 파일에 적힐 은행 이름(모르는 이름이면 적힌 그대로)
  account: string;         // 가린 계좌번호
  holder: string;          // 예금주(띄어쓰기 없이)
  amount: number;          // 이체할 금액(실수령액)
  problems: string[];      // 이체할 수 없는 까닭(있으면 고를 수 없다)
  warns: string[];         // 고를 수는 있지만 확인할 것
};
export type BankLine = { bank: string; account: string; amount: number; holder: string };

// 한 사람 → 파일의 한 줄과 화면에 알릴 것
export function bankRowOf(s: BankSource): { row: BankRow; line: BankLine | null } {
  const problems: string[] = [], warns: string[] = [];
  const known = kbBankName(s.bank);
  const bank = known || String(s.bank || "").trim();
  const digits = accountDigits(s.account_no);
  const holder = String(s.account_holder || s.name || "").replace(/\s/g, "");
  const amount = Math.round(Number(s.net_pay) || 0);
  if (!(amount > 0)) problems.push("실수령액이 0원 이하입니다");
  if (!bank) problems.push("은행이 비어 있습니다");
  if (!String(s.account_no || "").trim()) problems.push("계좌번호가 비어 있습니다");
  else if (!digits) problems.push("계좌번호에 숫자가 아닌 글자가 있습니다");
  if (!holder) problems.push("예금주가 비어 있습니다");
  if (bank && !known) warns.push(`은행 이름 '${bank}'은 양식의 은행 표에 없습니다`);
  if (s.account_holder && s.account_holder.replace(/\s/g, "") !== s.name.replace(/\s/g, "")) warns.push(`예금주(${holder})가 성명과 다릅니다`);
  const row: BankRow = { employee_id: s.employee_id, name: s.name, affiliation: s.affiliation, bank, account: maskAccount(digits), holder, amount, problems, warns };
  return { row, line: problems.length === 0 ? { bank, account: digits, amount, holder } : null };
}

// 통장에 찍힐 글의 기본값: 받는분 통장표시 "급여", 내 통장 메모 "급여이체11", 메모 "11월급여"(달 = 급여의 귀속월)
export type BankLabels = { recv: string; mine: string; memo: string };
export function bankLabels(month: string): BankLabels {
  const m = Number(month.slice(5, 7));
  return { recv: "급여", mine: `급여이체${m}`, memo: `${m}월급여` };
}
// 은행이 받는 길이로 다듬는다(받는분 통장표시·메모는 넉넉히, 내 통장 메모는 통장에 9자리까지 찍힌다 — 그보다 길면 은행이 자른다)
export function cleanLabels(raw: Partial<BankLabels> | null | undefined, month: string): BankLabels {
  const d = bankLabels(month);
  const t = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : null);
  return { recv: t(raw?.recv, 20) ?? d.recv, mine: t(raw?.mine, 20) ?? d.mine, memo: t(raw?.memo, 20) ?? d.memo };
}
// ── 양식 오른쪽 구역(I~V열) — 대표가 준 국민은행 양식의 글 그대로 ──────────
//  [줄, 열, 글]. I1·I11 은 I~V 로 병합된 제목, L7 은 빨간 글. 은행 표는 KB_BANKS 를 한 줄에 일곱 곳씩(이름·코드) 16줄부터.
export const KB_NOTE_TITLE = "* 유의사항(본 유의사항은 급여이체파일 등록 전에 모두 삭제해 주십시오.)";
export const KB_NOTE_LINES: [number, "I" | "J" | "L", string][] = [
  [2, "I", "1) A열"], [2, "J", "(은행명 또는 은행코드)"], [2, "L", ": 셀서식을 텍스트로 지정한 후 은행(기관)코드 3자리 숫자 또는 한글명 입력(*필수입력*)"],
  [3, "I", "2) B열"], [3, "J", "(입금계좌번호)"], [3, "L", ": 셀서식을 텍스트로 지정한 후 입금하실 계좌번호 입력 (‘-’ 생략가능)(*필수입력*)"],
  [4, "I", "3) C열"], [4, "J", "(이체금액)"], [4, "L", ": 이체하실 금액(‘,’ 생략가능), 소수점 금액 입력시 오류(error) 발생하므로 반드시 확인(*필수입력*)"],
  [5, "I", "4) D열"], [5, "J", "(예금주성명)"], [5, "L", ": 예금주성명(최대 20자리 입력가능)"],
  [6, "L", "☞ 띄어쓰기(SPACE) 등이 있는 경우 예금주성명조회시 불일치가 발생하므로, 반드시 TEXT만 입력)"],
  [7, "I", "5) E열"], [7, "J", "(받는분 통장표시)"], [7, "L", ": 급여성자금 확인을 위해 아래 예시 중 선택 입력 권장"],
  [8, "I", "6) F열(선택)"], [8, "J", "(내 통장 메모)"], [8, "L", ": 출금통장메모(적요) (통장에는 최대6자리인자, 미입력시 입금건별 예금주 표시)"],
  [9, "L", "- 내 통장 메모 건별기장을 원하시면 1회 최대 500건까지 등록가능합니다."],
  [10, "I", "7) G열(선택)"], [10, "J", "(메모)"], [10, "L", ": 메모기능으로 최대 10자리 입력가능"],
];
export const KB_RECV_TITLE = "* 받는분 통장표시(예시)";
export const KB_RECV_LINES = [
  "급여, 정기상여, 특별상여, 급여+상여, 연월차, 퇴직금, 퇴직금중간정산, 자기개발비, 성과급, 성과상여, 연차, 월차, 보로금",
  "연말정산환급분, 차등성과급, 급여소급분, 상여소급분, 휴가비, 복리후생비, 상여, 기타급여, 수당",
];
export const KB_BANK_TITLE = "* 주요 은행";
export const KB_BANK_TABLE_ROW = 16;     // 은행 표가 시작하는 줄
export const KB_BANKS_PER_ROW = 7;

export const BANK_SHEET = "급여이체";
export const BANK_AMOUNT_FMT = "#,##0_);[Red](#,##0)";
