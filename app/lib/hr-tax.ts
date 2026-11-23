// 원천세 집계 — 화면과 서버가 같이 쓰는 타입·순수 집계. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  원천징수이행상황신고는 '지급한 달' 기준이다: 그 달에 지급한 급여에서 뗀 소득세를 다음 달 10일까지 신고·납부한다.
//  그래서 귀속월이 아니라 지급일이 속한 달로 묶는다(10월분 급여를 11월 10일에 주면 11월 지급분 → 12월 10일까지).
//  지방소득세(소득세의 10%)는 같은 기한에 따로 낸다.
//  기준(바꾸면 숫자가 달라진다):
//   · 합계에는 확정한 급여만 넣는다. 작성 중인 급여는 금액이 바뀔 수 있어 줄에만 보인다.
//   · 인원 = 그 급여에서 지급 합계가 0보다 큰 직원 수.
//   · 신고서의 '총지급액'에 어떤 비과세가 들어가는지는 비과세 종류마다 다르다 — 지급 합계·비과세·과세 급여를 모두 보여 주고 고르지 않는다.
//   · 기한은 다음 달 10일을 그대로 적는다(그날이 휴일이면 다음 영업일 — 여기서는 따지지 않는다).

export type TaxHead = { id: string; workplace_id: string; month: string; pay_date: string; status: "confirmed" | "draft" };
export type TaxLine = { payroll_id: string; pay_total: number; exempt_total: number; taxable_total: number; income_tax: number; local_tax: number };
export type TaxRow = {
  payroll_id: string; workplace_id: string;
  month: string;        // 귀속월
  pay_date: string; pay_month: string;   // 지급일과 그 달(신고 기준)
  due: string;          // 신고·납부 기한(다음 달 10일)
  status: "confirmed" | "draft";
  people: number; pay_total: number; exempt_total: number; taxable_total: number; income_tax: number; local_tax: number;
};
export type TaxSum = { payrolls: number; people: number; pay_total: number; exempt_total: number; taxable_total: number; income_tax: number; local_tax: number };
export type TaxBundle = { year: number; workplaces: { id: string; name: string }[]; rows: TaxRow[] };

export function dueOf(payMonth: string): string {
  const [y, m] = payMonth.split("-").map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-10`;
}

// 급여 머리와 줄 → 급여마다 한 줄(지급일 순, 같은 날은 귀속월 순)
export function taxRows(heads: TaxHead[], lines: TaxLine[]): TaxRow[] {
  const by = new Map<string, TaxLine[]>();
  for (const l of lines) by.set(l.payroll_id, [...(by.get(l.payroll_id) || []), l]);
  return heads.map((h) => {
    const ls = by.get(h.id) || [];
    const sum = (k: keyof Omit<TaxLine, "payroll_id">) => ls.reduce((t, l) => t + (Number(l[k]) || 0), 0);
    const pay_month = h.pay_date.slice(0, 7);
    return {
      payroll_id: h.id, workplace_id: h.workplace_id, month: h.month, pay_date: h.pay_date, pay_month, due: dueOf(pay_month), status: h.status,
      people: ls.filter((l) => l.pay_total > 0).length,
      pay_total: sum("pay_total"), exempt_total: sum("exempt_total"), taxable_total: sum("taxable_total"), income_tax: sum("income_tax"), local_tax: sum("local_tax"),
    };
  }).sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.month.localeCompare(b.month) || a.workplace_id.localeCompare(b.workplace_id));
}

// 합계 — 확정한 급여만. 인원은 급여마다 센 수를 더한 것(연인원)이다.
export function sumTax(rows: TaxRow[]): TaxSum {
  const s: TaxSum = { payrolls: 0, people: 0, pay_total: 0, exempt_total: 0, taxable_total: 0, income_tax: 0, local_tax: 0 };
  for (const r of rows) {
    if (r.status !== "confirmed") continue;
    s.payrolls++; s.people += r.people; s.pay_total += r.pay_total; s.exempt_total += r.exempt_total; s.taxable_total += r.taxable_total;
    s.income_tax += r.income_tax; s.local_tax += r.local_tax;
  }
  return s;
}

// 지급한 달이 상반기(1~6월)인가 — 반기마다 신고하는 사업장이 반기 합계를 쓴다
export const isFirstHalf = (payMonth: string): boolean => Number(payMonth.slice(5, 7)) <= 6;
