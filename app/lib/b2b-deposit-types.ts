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
