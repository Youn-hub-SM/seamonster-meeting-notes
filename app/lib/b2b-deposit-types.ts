// 은행 입금 자동확인 — 타입·상수·순수 헬퍼 (클라이언트 안전).
// 서버 로직(팝빌 수집·매칭 실행)은 b2b-deposits.ts — supabase/next 서버 의존이라 화면에서 import 금지.
// supabase/migrations/089_bank_deposits.sql 의 bank_deposits 와 1:1.

export const DEPOSIT_STATUSES = ["확인필요", "자동매칭", "수동매칭", "무시"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

// 색 지도 (같은 의미는 여기서 조회 — 화면에서 색을 새로 선언하지 않는다)
export const DEPOSIT_STATUS_COLORS: Record<DepositStatus, { bg: string; fg: string }> = {
  "확인필요": { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  "자동매칭": { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  "수동매칭": { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  "무시": { bg: "var(--sm-border)", fg: "var(--sm-text-mid)" },
};

export interface BankDeposit {
  id: string;
  tid: string;
  trdate: string;              // yyyyMMdd
  trdt: string;                // yyyyMMddHHmmss
  amount: number;
  balance: number | null;
  remark: string | null;       // 입금자명·적요
  status: DepositStatus;
  matched_order_id: string | null;
  payment_id: string | null;
  matched_by: string | null;
  matched_at: string | null;
  created_at: string;
}

// 미수금 발주 요약 (매칭 후보 계산·수동 선택용)
export interface UnpaidOrderLite {
  id: string;
  order_no: string;
  company_name: string;
  payment_status: string;
  total: number;
  paid: number;
  remaining: number;
}

export interface DepositCandidate {
  order: UnpaidOrderLite;
  nameHit: boolean;    // 입금자명 ↔ 업체명 일치
  amountHit: boolean;  // 입금액 = 잔액
}

// 입금자명·업체명 정규화 — 공백·법인 접두어·특수문자 제거 후 비교
export function normalizeDepositName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/주식회사|유한회사|\(주\)|㈜|\(유\)/g, "")
    .replace(/[^0-9a-z가-힣]/g, "");
}

// 입금 1건의 매칭 후보 — 이름 일치 또는 금액=잔액. (둘 다) > 금액 > 이름 순 정렬.
export function candidateOrders(
  dep: Pick<BankDeposit, "amount" | "remark">,
  unpaid: UnpaidOrderLite[]
): DepositCandidate[] {
  const depName = normalizeDepositName(dep.remark);
  const score = (c: DepositCandidate) => (c.nameHit && c.amountHit ? 3 : c.amountHit ? 2 : 1);
  return unpaid
    .map((o) => {
      const comp = normalizeDepositName(o.company_name);
      const nameHit =
        depName.length >= 2 && comp.length >= 2 && (depName.includes(comp) || comp.includes(depName));
      const amountHit = o.remaining > 0 && Number(dep.amount) === o.remaining;
      return { order: o, nameHit, amountHit };
    })
    .filter((c) => c.nameHit || c.amountHit)
    .sort((a, b) => score(b) - score(a));
}

export function ymdToIso(ymd: string): string {
  const s = String(ymd);
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

// yyyyMMddHHmmss → "MM-DD HH:mm" (피드 표시용)
export function formatTrdt(trdt: string): string {
  const s = String(trdt);
  if (s.length < 12) return s;
  return `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

// ─────────────────────────────────────────────
// 입금 알림 문자 파싱 (웹훅 수집 경로 — 팝빌 대신 폰의 입금 문자/푸시를 전달받는다)
// ─────────────────────────────────────────────
export interface ParsedDepositSms {
  amount: number;
  name: string | null;             // 입금자명 (파싱 실패 시 null — 확인필요로 남는다)
  month: number | null;            // 문자에 찍힌 MM/DD HH:mm (연도 없음 — 수신 시점에 보정)
  day: number | null;
  hour: number | null;
  minute: number | null;
}

// KB 입금 알림 파싱 — 형식 변형에 견디도록 키워드 기반으로 뽑는다.
//  예) "[KB]08/10 14:32 123456**789 홍길동 입금 1,000,000 잔액 5,000,000"
//      "[Web발신] KB국민은행 08/10 14:32 입금 1,000,000원 (주)어쩌구 잔액..."
//  입금 문구가 없거나 금액을 못 찾으면 null (출금·인증 문자 등은 버린다).
export function parseKbDepositSms(text: string): ParsedDepositSms | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || !/입금/.test(t)) return null;

  // 금액: '입금' 뒤 첫 숫자 우선, 없으면 'N원' 형태 중 첫 번째
  const amtAfter = t.match(/입금[^\d]{0,8}([\d,]+)\s*원?/);
  const amtAny = t.match(/([\d,]{2,})\s*원/);
  const amtStr = amtAfter?.[1] ?? amtAny?.[1];
  const amount = amtStr ? Number(amtStr.replace(/,/g, "")) : 0;
  if (!amount || amount <= 0) return null;

  const dm = t.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);

  // 이름: 날짜·시각·금액·계좌 마스킹·은행 상용구를 걷어내고 남는 글자
  const name =
    t
      .replace(/\[[^\]]*\]/g, " ")                       // [KB] [Web발신] 등
      .replace(/\d{1,2}\/\d{1,2}/g, " ")                 // 날짜
      .replace(/\d{1,2}:\d{2}/g, " ")                    // 시각
      .replace(/[\d,]+\s*원/g, " ")                      // 금액+원
      .replace(/입금[^\d\s]{0,2}\s*[\d,]+/g, " ")        // 입금 1,000,000 (원 없음)
      .replace(/잔액\s*[\d,]*원?/g, " ")
      .replace(/[\d*]{4,}[\d*-]*/g, " ")                 // 계좌번호·마스킹
      .replace(/KB국민은행|KB국민|국민은행|KB|Web발신|전자금융|스타뱅킹|입출금|입금액?|출금|통보|알림/gi, " ")
      .replace(/[^0-9A-Za-z가-힣() ]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null;

  return {
    amount,
    name,
    month: dm ? Number(dm[1]) : null,
    day: dm ? Number(dm[2]) : null,
    hour: dm ? Number(dm[3]) : null,
    minute: dm ? Number(dm[4]) : null,
  };
}
