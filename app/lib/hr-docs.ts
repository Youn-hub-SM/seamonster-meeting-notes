// 증명서 — 화면과 서버가 같이 쓰는 타입·순수 함수. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  서류 3가지. 내용은 전부 이미 있는 자료에서 읽는다(인사대장·사업장·확정한 월 급여) — 증명서용으로 따로 저장하는 값이 없다.
//   · 재직증명서: 재직 중인 직원. 성명·생년월일(또는 주민등록번호)·주소·부서·직위·입사일·재직 기간.
//   · 경력증명서: 재직자·퇴사자. 근무 기간·부서·직위·담당 업무.
//   · 갑종근로소득에 대한 소득세 원천징수증명서: 고른 기간의 달별 급여액과 원천징수한 소득세·지방소득세.
//       **급여를 확정한 달만** 나온다. 연말정산으로 확정한 결정세액이 아니라 달마다 실제로 뗀 세금이다
//       (연말정산용 '근로소득 원천징수영수증'은 이 창의 자료로 만들 수 없다).
//  용도·제출처·발급일은 발급할 때 넣고 저장하지 않는다. 발급한 사실은 hr.audit_log 에 남고, 그 줄의 번호가 발급 번호다.

export const DOC_KINDS = ["employment", "career", "withholding"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_LABEL: Record<DocKind, string> = {
  employment: "재직증명서", career: "경력증명서", withholding: "갑종근로소득에 대한 소득세 원천징수증명서",
};
export const DOC_TAB: Record<DocKind, string> = { employment: "재직증명서", career: "경력증명서", withholding: "원천징수증명서" };

export type WithholdingRow = {
  month: string; pay_date: string;
  pay_total: number; exempt_total: number; taxable_total: number; income_tax: number; local_tax: number;
};
export const sumWithholding = (rows: WithholdingRow[]) => rows.reduce(
  (t, r) => ({ pay_total: t.pay_total + r.pay_total, exempt_total: t.exempt_total + r.exempt_total, taxable_total: t.taxable_total + r.taxable_total, income_tax: t.income_tax + r.income_tax, local_tax: t.local_tax + r.local_tax }),
  { pay_total: 0, exempt_total: 0, taxable_total: 0, income_tax: 0, local_tax: 0 },
);

// 발급 번호: 발급한 해 + 이력 줄 번호(6자리). 예: 제 2026-000123 호
export const issueNo = (issueDate: string, auditId: number): string => `${issueDate.slice(0, 4)}-${String(auditId).padStart(6, "0")}`;
// 2026-11-21 → 2026년 11월 21일
export const dateKo = (d: string | null | undefined): string => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(0, 4))}년 ${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일` : "");
export const monthKo = (m: string): string => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5, 7))}월`;

// 직인 이미지: PNG·JPEG, 약 500KB 까지(data URL 글자 수로 본다 — DB 의 확인과 같은 기준)
export const STAMP_MAX_CHARS = 700000;
export const isStampDataUrl = (s: unknown): s is string => typeof s === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= STAMP_MAX_CHARS;
