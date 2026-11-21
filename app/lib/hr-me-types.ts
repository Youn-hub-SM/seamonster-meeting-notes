// 직원 확인 링크 — 직원 화면(/me)과 서버가 같이 쓰는 타입. 비밀(키·DB)에 닿는 코드는 두지 않는다.
//
//  직원이 보는 것은 본인 것뿐이다: 확정한 달의 급여명세서, 연차(발생·사용·잔여), 근태(달별 근무대장).
//  주민등록번호·계좌번호·다른 직원 정보는 이 묶음에 싣지 않는다.

import type { PayResult } from "./hr-pay";
import type { WorkLog } from "./hr-work";
import type { GrantView, LeaveSummary } from "./hr-leave";

// 명세서에 찍히는 것만 — 회사 부담 보험료(employer)와 담당자용 확인 문구(warnings)는 싣지 않는다
export type MePayResult = Pick<PayResult, "basis" | "items" | "pay_total" | "taxable_total" | "exempt_total" | "deduct_total" | "net_pay">;
export type MePayslip = { month: string; pay_date: string; result: MePayResult };
export type MeAttendance = {
  month: string;
  logs: Pick<WorkLog, "work_date" | "kind" | "start_time" | "end_time" | "hours" | "night_hours" | "leave_days">[];
  workDays: number; worked: number; overtime: number; night: number; holiday: number; weekly: number; leaveDays: number; absentDays: number;
};
export type MeBundle = {
  need: null;
  today: string;
  me: { name: string; emp_no: string; dept: string; position: string; hire_date: string; workplace: string; pay_type: "hourly" | "monthly" };
  payslips: MePayslip[];                       // 확정한 달만, 최근 달부터
  leave: (Omit<LeaveSummary, "grants"> & { grants: GrantView[]; uses: { work_date: string; days: number }[] }) | null; // null = 연차 표 없음
  attendance: MeAttendance;
};
// 본인 확인 전: 이름조차 주지 않는다. locked = 15분 잠금, blocked = 계속 틀려 잠긴 링크(담당자가 다시 만들어야 풀린다)
export type MeGate = { need: "verify"; locked: boolean; blocked: boolean; can_verify: boolean };
export type MeResponse = MeBundle | MeGate;
