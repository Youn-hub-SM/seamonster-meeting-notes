"use client";

// 직원 등록·정보 수정 창 — 인사대장 목록과 인사기록카드가 같이 쓴다.
//  주민등록번호: 수정할 때는 칸을 비워 둔 채 연다(비우면 그대로, 새로 적으면 바뀐다). 번호는 서버가 암호화해 저장한다.

import { useMemo, useState } from "react";
import { useEscClose } from "@/app/lib/use-esc";
import {
  EMP_TYPES, WEEKDAYS, affiliationOptions, ageOn, currentWage, numText, parseRrn, todayKst, typeRrn,
  type Employee, type Workplace,
} from "@/app/lib/hr";
import { HrApiError, hrApi } from "./api";

type Form = {
  workplace_id: string; affiliation: string; emp_no: string; name: string; rrn: string;
  address: string; phone: string; emergency: string;
  hire_date: string; leave_date: string; leave_reason: string;
  dept: string; position: string; job: string; emp_type: string;
  contract_start: string; contract_end: string; career: string;
  pay_type: "hourly" | "monthly"; hourly_wage: string; monthly_wage: string; wage_from: string;
  work_days: number[]; work_start: string; work_end: string; break_min: string; daily_hours: string;
  dependents: string; children: string; tax_rate: 80 | 100 | 120;
  ins_pension: boolean; ins_health: boolean; ins_employment: boolean;
  ins_basis: "notice" | "actual"; pension_base: string; health_base: string;
  bank: string; account_no: string; account_holder: string;
  leave_basis: "" | "hire" | "fiscal"; memo: string;
};

function initial(e: Employee | null, workplaces: Workplace[]): Form {
  const w = e ? currentWage(e.wages) : null;
  return {
    workplace_id: e?.workplace_id || workplaces.find((x) => x.active)?.id || workplaces[0]?.id || "",
    affiliation: e?.affiliation || "", emp_no: e?.emp_no || "", name: e?.name || "", rrn: "",
    address: e?.address || "", phone: e?.phone || "", emergency: e?.emergency || "",
    hire_date: e?.hire_date || todayKst(), leave_date: e?.leave_date || "", leave_reason: e?.leave_reason || "",
    dept: e?.dept || "", position: e?.position || "", job: e?.job || "", emp_type: e?.emp_type || "정규직",
    contract_start: e?.contract_start || "", contract_end: e?.contract_end || "", career: e?.career || "",
    pay_type: e?.pay_type || "hourly",
    hourly_wage: w ? String(w.hourly_wage || "") : "", monthly_wage: w ? String(w.monthly_wage || "") : "",
    wage_from: w?.effective_from || "",
    work_days: e?.work_days || [1, 2, 3, 4, 5], work_start: e?.work_start || "09:00", work_end: e?.work_end || "18:00",
    break_min: String(e?.break_min ?? 60), daily_hours: String(e?.daily_hours ?? 8),
    dependents: String(e?.dependents ?? 1), children: String(e?.children ?? 0), tax_rate: e?.tax_rate || 100,
    ins_pension: e?.ins_pension ?? true, ins_health: e?.ins_health ?? true, ins_employment: e?.ins_employment ?? true,
    ins_basis: e?.ins_basis || "notice", pension_base: e ? String(e.pension_base || "") : "", health_base: e ? String(e.health_base || "") : "",
    bank: e?.bank || "", account_no: e?.account_no || "", account_holder: e?.account_holder || "",
    leave_basis: e?.leave_basis || "", memo: e?.memo || "",
  };
}

// 출근·퇴근·휴게 → 하루 근로시간(소수 둘째 자리). 퇴근이 출근보다 이르면 다음 날로 본다.
function hoursBetween(start: string, end: string, breakMin: number): number | null {
  const m = (s: string) => { const x = /^(\d{2}):(\d{2})$/.exec(s); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const a = m(start), b = m(end);
  if (a == null || b == null) return null;
  const span = (b > a ? b - a : b + 1440 - a) - (Number.isFinite(breakMin) ? breakMin : 0);
  return span > 0 ? Math.round((span / 60) * 100) / 100 : null;
}
const onlyDigits = (s: string) => s.replace(/[^\d]/g, "");
const withComma = (s: string) => (s ? Number(s).toLocaleString("ko-KR") : "");

export default function EmployeeForm({
  employee, workplaces, minWage, keyReady, onClose, onSaved,
}: {
  employee: Employee | null;          // null = 새 직원
  workplaces: Workplace[];
  minWage: number | null;             // 오늘 유효한 최저임금(요율표). 없으면 검사하지 않는다
  keyReady: boolean;                  // 주민등록번호 암호화 키(HR_DATA_KEY)가 서버에 있는가
  onClose: () => void;
  onSaved: (e: Employee, note?: string) => void;
}) {
  const [f, setF] = useState<Form>(() => initial(employee, workplaces));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const rrnParsed = useMemo(() => (f.rrn.trim() ? parseRrn(f.rrn) : null), [f.rrn]);
  const birth = rrnParsed?.ok ? rrnParsed.info.birth : employee?.birth_date || null;
  const age = ageOn(birth);
  const lowWage = f.pay_type === "hourly" && minWage != null && f.hourly_wage !== "" && Number(f.hourly_wage) > 0 && Number(f.hourly_wage) < minWage;
  // 소속: 고른 사업장의 소속 목록(+ 목록에는 없지만 이 직원에게 들어 있는 값). 목록이 없는 사업장은 칸을 보이지 않는다
  const affList = workplaces.find((w) => w.id === f.workplace_id)?.affiliations || [];
  const affOptions = affiliationOptions(affList, f.affiliation);

  // 시각·휴게를 고치면 하루 시간을 따라 고친다(직접 적은 값은 그 뒤에 다시 고칠 수 있다)
  function setTime(k: "work_start" | "work_end" | "break_min", v: string) {
    setF((p) => {
      const next = { ...p, [k]: v };
      const h = hoursBetween(next.work_start, next.work_end, Number(next.break_min));
      return h == null ? next : { ...next, daily_hours: String(h) };
    });
  }
  function toggleDay(d: number) {
    setF((p) => ({ ...p, work_days: p.work_days.includes(d) ? p.work_days.filter((x) => x !== d) : [...p.work_days, d].sort() }));
  }

  async function save() {
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = "성명을 입력하세요";
    if (!f.workplace_id) errs.workplace_id = "사업장을 고르세요";
    if (!f.hire_date) errs.hire_date = "입사일을 입력하세요";
    if (f.rrn.trim() && rrnParsed && !rrnParsed.ok) errs.rrn = rrnParsed.error;
    if (f.pay_type === "hourly" && !Number(f.hourly_wage)) errs.hourly_wage = "시급을 입력하세요";
    if (f.pay_type === "monthly" && !Number(f.monthly_wage)) errs.monthly_wage = "월급을 입력하세요";
    if (employee && !f.wage_from) errs.wage_from = "적용 시작일을 입력하세요";
    setErrors(errs);
    if (Object.keys(errs).length > 0) { setFormError("입력을 확인하세요."); return; }

    const body: Record<string, unknown> = {
      workplace_id: f.workplace_id, affiliation: f.affiliation, emp_no: f.emp_no, name: f.name,
      address: f.address, phone: f.phone, emergency: f.emergency,
      hire_date: f.hire_date, leave_date: f.leave_date, leave_reason: f.leave_reason,
      dept: f.dept, position: f.position, job: f.job, emp_type: f.emp_type,
      contract_start: f.contract_start, contract_end: f.contract_end, career: f.career,
      pay_type: f.pay_type, work_days: f.work_days, work_start: f.work_start, work_end: f.work_end,
      break_min: f.break_min, daily_hours: f.daily_hours,
      dependents: f.dependents, children: f.children, tax_rate: f.tax_rate,
      ins_pension: f.ins_pension, ins_health: f.ins_health, ins_employment: f.ins_employment,
      ins_basis: f.ins_basis, pension_base: f.pension_base, health_base: f.health_base,
      bank: f.bank, account_no: f.account_no, account_holder: f.account_holder,
      leave_basis: f.leave_basis, memo: f.memo,
    };
    if (f.rrn.trim()) body.rrn = f.rrn;
    // 임금: 새 직원은 늘 보낸다. 수정은 금액이나 적용 시작일이 달라졌을 때만(같은 날짜면 그 줄을 고치고, 새 날짜면 줄이 더해진다)
    const cur = employee ? currentWage(employee.wages) : null;
    const hourly = Number(f.hourly_wage) || 0, monthly = Number(f.monthly_wage) || 0;
    if (!employee || !cur || cur.hourly_wage !== hourly || cur.monthly_wage !== monthly || cur.effective_from !== f.wage_from) {
      body.hourly_wage = hourly; body.monthly_wage = monthly; body.wage_from = f.wage_from || f.hire_date;
    }

    setBusy(true); setFormError("");
    try {
      const j = await hrApi<{ employee: Employee; rrnWarn?: boolean }>(
        employee ? `/api/hr/employees/${employee.id}` : "/api/hr/employees", employee ? "PATCH" : "POST", body);
      onSaved(j.employee, j.rrnWarn ? "주민등록번호의 검증 숫자가 맞지 않습니다. 번호를 다시 확인하세요." : undefined);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); }
      else setFormError("저장하지 못했습니다.");
      setBusy(false);
    }
  }

  const err = (k: string) => (errors[k] ? <span className="b2b-field-error">{errors[k]}</span> : null);
  const inv = (k: string) => (errors[k] ? ("true" as const) : undefined);
  const text = (k: keyof Form, label: string, opt?: { type?: string; ph?: string; req?: boolean; cls?: string; max?: number }) => (
    <label className={`b2b-field ${opt?.cls || ""}`}>
      <span className="b2b-field-label">{label}{opt?.req && <span className="req">*</span>}</span>
      <input className="b2b-input" type={opt?.type || "text"} value={f[k] as string} maxLength={opt?.max}
        onChange={(e) => set(k, e.target.value as Form[typeof k])} placeholder={opt?.ph} aria-invalid={inv(k)} />
      {err(k)}
    </label>
  );
  const money = (k: "hourly_wage" | "monthly_wage" | "pension_base" | "health_base", label: string, req?: boolean) => (
    <label className="b2b-field">
      <span className="b2b-field-label">{label}{req && <span className="req">*</span>}</span>
      <input className="b2b-input num" inputMode="numeric" value={withComma(f[k])} placeholder="0"
        onChange={(e) => set(k, onlyDigits(e.target.value))} aria-invalid={inv(k)} />
      {err(k)}
      {k === "hourly_wage" && lowWage && <span className="hr-field-note is-warn">최저임금 {numText(minWage)}원보다 낮습니다</span>}
    </label>
  );

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label={employee ? "직원 정보 수정" : "직원 등록"}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{employee ? `${employee.name} 정보 수정` : "직원 등록"}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <h3>기본</h3>
              {workplaces.length > 1 && (
                <label className="b2b-field">
                  <span className="b2b-field-label">사업장<span className="req">*</span></span>
                  {/* 사업장을 바꾸면 소속은 비운다 — 소속 목록이 사업장마다 다르다 */}
                  <select className="b2b-input" value={f.workplace_id} onChange={(e) => setF((p) => ({ ...p, workplace_id: e.target.value, affiliation: "" }))} aria-invalid={inv("workplace_id")}>
                    {workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                  {err("workplace_id")}
                </label>
              )}
              {affOptions.length > 0 && (
                <label className="b2b-field">
                  <span className="b2b-field-label">소속</span>
                  <select className="b2b-input" value={f.affiliation} onChange={(e) => set("affiliation", e.target.value)} aria-invalid={inv("affiliation")}>
                    <option value="">정하지 않음</option>
                    {affOptions.map((a) => <option key={a} value={a}>{a}{affList.includes(a) ? "" : " (목록에 없음)"}</option>)}
                  </select>
                  {err("affiliation")}
                </label>
              )}
              {text("name", "성명", { req: true, max: 60 })}
              <label className="b2b-field">
                <span className="b2b-field-label">주민등록번호{employee?.has_rrn && <span className="opt"> 비우면 그대로</span>}</span>
                <input className="b2b-input hr-mono" inputMode="numeric" autoComplete="off" value={f.rrn} disabled={!keyReady}
                  onChange={(e) => set("rrn", typeRrn(e.target.value))} placeholder={employee?.rrn_masked || "000000-0000000"} aria-invalid={inv("rrn")} />
                {err("rrn")}
                {!keyReady && <span className="hr-field-note is-warn">암호화 키(HR_DATA_KEY)가 없어 번호를 저장할 수 없습니다</span>}
                {!errors.rrn && rrnParsed?.ok && (
                  <span className={`hr-field-note ${rrnParsed.info.checksumOk ? "" : "is-warn"}`}>
                    {rrnParsed.info.birth} {rrnParsed.info.gender}{rrnParsed.info.foreigner ? " 외국인" : ""}
                    {rrnParsed.info.checksumOk ? "" : " — 검증 숫자가 맞지 않습니다"}
                  </span>
                )}
                {!errors.rrn && rrnParsed && !rrnParsed.ok && f.rrn.replace(/\D/g, "").length === 13 && <span className="hr-field-note is-warn">{rrnParsed.error}</span>}
              </label>
              {text("phone", "연락처", { ph: "010-0000-0000", max: 40 })}
              {text("emergency", "비상 연락처", { max: 100 })}
              {text("address", "주소", { cls: "hr-wide", max: 300 })}
            </section>

            <section className="hr-form-sec">
              <h3>고용</h3>
              {text("hire_date", "입사일", { type: "date", req: true })}
              {text("leave_date", "퇴사일", { type: "date" })}
              {text("leave_reason", "퇴사 사유", { max: 300 })}
              {text("dept", "부서", { max: 60 })}
              {text("position", "직위", { max: 60 })}
              {text("job", "업무", { max: 100 })}
              <label className="b2b-field">
                <span className="b2b-field-label">고용 형태</span>
                <select className="b2b-input" value={f.emp_type} onChange={(e) => set("emp_type", e.target.value)}>
                  {EMP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              {text("contract_start", "계약 시작일", { type: "date" })}
              {text("contract_end", "계약 종료일", { type: "date" })}
              <label className="b2b-field hr-wide">
                <span className="b2b-field-label">이력</span>
                <textarea className="b2b-input" value={f.career} onChange={(e) => set("career", e.target.value)} maxLength={4000} />
              </label>
            </section>

            <section className="hr-form-sec">
              <h3>근로 조건</h3>
              <div className="b2b-field">
                <span className="b2b-field-label">급여 형태</span>
                <div className="sm-tabs">
                  <button type="button" className={`sm-tab ${f.pay_type === "hourly" ? "is-active" : ""}`} onClick={() => set("pay_type", "hourly")}>시급</button>
                  <button type="button" className={`sm-tab ${f.pay_type === "monthly" ? "is-active" : ""}`} onClick={() => set("pay_type", "monthly")}>월급</button>
                </div>
              </div>
              {f.pay_type === "hourly" ? money("hourly_wage", "시급", true) : money("monthly_wage", "월급", true)}
              <label className="b2b-field">
                <span className="b2b-field-label">임금 적용 시작일{!employee && <span className="opt"> 비우면 입사일</span>}</span>
                <input className="b2b-input" type="date" value={f.wage_from} onChange={(e) => set("wage_from", e.target.value)} aria-invalid={inv("wage_from")} />
                {err("wage_from")}
              </label>
              <div className="b2b-field hr-wide">
                <span className="b2b-field-label">소정근로 요일</span>
                <div className="hr-days">
                  {WEEKDAYS.map((d, i) => (
                    <button key={d} type="button" className={`sm-tab ${f.work_days.includes(i + 1) ? "is-active" : ""}`} aria-pressed={f.work_days.includes(i + 1)} onClick={() => toggleDay(i + 1)}>{d}</button>
                  ))}
                </div>
              </div>
              <label className="b2b-field">
                <span className="b2b-field-label">출근</span>
                <input className="b2b-input" type="time" value={f.work_start} onChange={(e) => setTime("work_start", e.target.value)} aria-invalid={inv("work_start")} />
                {err("work_start")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">퇴근</span>
                <input className="b2b-input" type="time" value={f.work_end} onChange={(e) => setTime("work_end", e.target.value)} aria-invalid={inv("work_end")} />
                {err("work_end")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">휴게(분)</span>
                <input className="b2b-input num" inputMode="numeric" value={f.break_min} onChange={(e) => setTime("break_min", onlyDigits(e.target.value))} aria-invalid={inv("break_min")} />
                {err("break_min")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">하루 소정근로시간</span>
                <input className="b2b-input num" inputMode="decimal" value={f.daily_hours} onChange={(e) => set("daily_hours", e.target.value.replace(/[^\d.]/g, ""))} aria-invalid={inv("daily_hours")} />
                {err("daily_hours")}
              </label>
            </section>

            <section className="hr-form-sec">
              <h3>세금·4대보험</h3>
              <label className="b2b-field">
                <span className="b2b-field-label">공제대상가족 수<span className="opt"> 본인 포함</span></span>
                <input className="b2b-input num" inputMode="numeric" value={f.dependents} onChange={(e) => set("dependents", onlyDigits(e.target.value))} aria-invalid={inv("dependents")} />
                {err("dependents")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">8~20세 자녀 수</span>
                <input className="b2b-input num" inputMode="numeric" value={f.children} onChange={(e) => set("children", onlyDigits(e.target.value))} aria-invalid={inv("children")} />
                {err("children")}
              </label>
              <div className="b2b-field">
                <span className="b2b-field-label">원천징수 비율</span>
                <div className="sm-tabs">
                  {([80, 100, 120] as const).map((r) => (
                    <button key={r} type="button" className={`sm-tab ${f.tax_rate === r ? "is-active" : ""}`} onClick={() => set("tax_rate", r)}>{r}%</button>
                  ))}
                </div>
              </div>
              <div className="b2b-field hr-wide">
                <span className="b2b-field-label">가입</span>
                <div className="hr-checks">
                  <label><input type="checkbox" className="b2b-checkbox" checked={f.ins_pension} onChange={(e) => set("ins_pension", e.target.checked)} />국민연금</label>
                  <label><input type="checkbox" className="b2b-checkbox" checked={f.ins_health} onChange={(e) => set("ins_health", e.target.checked)} />건강보험·장기요양</label>
                  <label><input type="checkbox" className="b2b-checkbox" checked={f.ins_employment} onChange={(e) => set("ins_employment", e.target.checked)} />고용보험</label>
                </div>
                {age != null && age >= 60 && f.ins_pension && <span className="hr-field-note is-warn">만 {age}세 — 만 60세부터는 국민연금 가입 대상이 아닙니다</span>}
                {age != null && age >= 65 && f.ins_employment && <span className="hr-field-note is-warn">만 {age}세 — 만 65세 이후에 고용됐다면 고용보험(실업급여) 대상이 아닙니다</span>}
              </div>
              <div className="b2b-field">
                <span className="b2b-field-label">국민연금·건강보험 기준</span>
                <div className="sm-tabs">
                  <button type="button" className={`sm-tab ${f.ins_basis === "notice" ? "is-active" : ""}`} onClick={() => set("ins_basis", "notice")}>공단 고지</button>
                  <button type="button" className={`sm-tab ${f.ins_basis === "actual" ? "is-active" : ""}`} onClick={() => set("ins_basis", "actual")}>그달 급여</button>
                </div>
              </div>
              {f.ins_basis === "notice" && money("pension_base", "국민연금 기준소득월액")}
              {f.ins_basis === "notice" && money("health_base", "건강보험 보수월액")}
            </section>

            <section className="hr-form-sec">
              <h3>지급·기타</h3>
              {text("bank", "은행", { max: 40 })}
              {text("account_no", "계좌번호", { max: 60 })}
              {text("account_holder", "예금주", { max: 60 })}
              <label className="b2b-field">
                <span className="b2b-field-label">연차 기준</span>
                <select className="b2b-input" value={f.leave_basis} onChange={(e) => set("leave_basis", e.target.value as Form["leave_basis"])}>
                  <option value="">사업장 기본값</option>
                  <option value="hire">입사일 기준</option>
                  <option value="fiscal">회계연도 기준</option>
                </select>
              </label>
              <label className="b2b-field hr-wide">
                <span className="b2b-field-label">메모</span>
                <textarea className="b2b-input" value={f.memo} onChange={(e) => set("memo", e.target.value)} maxLength={4000} />
              </label>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : employee ? "변경 저장" : "직원 등록"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
