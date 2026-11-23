"use client";

// 인사기록카드 — 직원 한 사람. 주민등록번호는 가려 두고 [번호 보기]를 눌렀을 때만 전체를 보인다(이력에 남는다).

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConfirm, useToast } from "@/app/components/Feedback";
import {
  LEAVE_BASIS_LABEL, PAY_TYPE_LABEL, ageOn, isActiveOn, numText, rateOn, tenureText, todayKst, wageOn, workDaysText,
  type Employee, type Rate, type Wage, type Workplace,
} from "@/app/lib/hr";
import { HrApiError, errText, hrApi } from "../../api";
import EmployeeForm from "../../EmployeeForm";
import LinkField from "./LinkField";

export default function HrEmployeeCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const toast = useToast();
  const confirm = useConfirm();
  const [e, setE] = useState<Employee | null>(null);
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [keyReady, setKeyReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rrn, setRrn] = useState<string | null>(null); // 전체 번호 — 보는 동안만 메모리에
  const [formOpen, setFormOpen] = useState(false);
  const today = todayKst();

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [one, w, r] = await Promise.all([
        hrApi<{ employee: Employee; keyReady: boolean }>(`/api/hr/employees/${id}`),
        hrApi<{ workplaces: Workplace[] }>("/api/hr/workplaces"),
        hrApi<{ rates: Rate[] }>("/api/hr/rates"),
      ]);
      setE(one.employee); setKeyReady(one.keyReady); setWorkplaces(w.workplaces); setRates(r.rates);
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "직원 정보를 불러오지 못했습니다."));
    }
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function showRrn() {
    if (!e) return;
    try {
      const j = await hrApi<{ rrn: Record<string, string> }>("/api/hr/employees/rrn", "POST", { ids: [e.id], purpose: "view" });
      setRrn(j.rrn[e.id] || null);
    } catch (err) { toast.error(errText(err, "주민등록번호를 불러오지 못했습니다.")); }
  }

  async function removeWage(w: Wage) {
    if (!e) return;
    const ok = await confirm({ title: `${w.effective_from} 임금 줄 삭제`, body: "이 날짜부터의 임금이 앞 줄의 금액으로 돌아갑니다.", action: "임금 줄 삭제" });
    if (!ok) return;
    try {
      await hrApi(`/api/hr/employees/${e.id}?wage=${w.id}`, "DELETE");
      setE({ ...e, wages: e.wages.filter((x) => x.id !== w.id) });
      toast.success("임금 줄을 삭제했습니다");
    } catch (err) { toast.error(errText(err, "임금 줄을 삭제하지 못했습니다.")); }
  }

  if (loading) return <div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>;
  if (error || !e) {
    return (
      <div className="b2b-container">
        <Link href="/hr/employees" className="sm-link hr-back">인사대장</Link>
        <div className="b2b-error" role="alert">{error || "없는 직원입니다."}</div>
      </div>
    );
  }

  const wp = workplaces.find((w) => w.id === e.workplace_id);
  const active = isActiveOn(e, today);
  const age = ageOn(e.birth_date, today);
  const nowWage = wageOn(e.wages, today);
  const minWage = rateOn(rates, today)?.min_wage ?? null;
  const yn = (b: boolean) => (b ? "가입" : "제외");
  const item = (label: string, value: string | null | undefined, wide = false) => (
    <div className={wide ? "hr-wide" : ""}>
      <dt>{label}</dt>
      <dd className={value ? "" : "is-empty"}>{value || "·"}</dd>
    </div>
  );

  return (
    <div className="b2b-container">
      {/* 인사기록카드 인쇄는 A4 세로 — 이 화면에 있을 때만 적용된다 */}
      <style>{`@media print { @page { size: A4 portrait; margin: 14mm; } }`}</style>

      <Link href="/hr/employees" className="sm-link hr-back hr-noprint">인사대장</Link>
      <header className="b2b-page-head">
        <div className="hr-card-title">
          <h1 className="b2b-page-title">{e.name}</h1>
          <span className={`b2b-status-pill ${active ? "hr-pill-ok" : "hr-pill-off"}`}>{active ? "재직" : e.hire_date > today ? "입사 전" : "퇴사"}</span>
          <span className="hr-print-only" style={{ fontSize: "9pt" }}>인사기록카드 · {[wp?.name, e.affiliation].filter(Boolean).join(" ")} · {today}</span>
        </div>
        <div className="b2b-page-actions hr-noprint">
          {e.has_rrn && (rrn
            ? <button type="button" className="b2b-btn-secondary" onClick={() => setRrn(null)}>번호 가리기</button>
            : <button type="button" className="b2b-btn-secondary" onClick={showRrn} disabled={!keyReady}>번호 보기</button>)}
          <Link href={`/hr/docs?employee=${e.id}&doc=contract`} prefetch={false} className="b2b-btn-secondary">근로계약서 작성</Link>
          <button type="button" className="b2b-btn-secondary" onClick={() => window.print()}>인사기록카드 인쇄</button>
          <button type="button" className="b2b-btn-primary" onClick={() => setFormOpen(true)}>정보 수정</button>
        </div>
      </header>

      <section className="hr-card-sec">
        <h2>기본</h2>
        <dl className="hr-dl">
          {item("사업장", wp?.name)}
          {((wp?.affiliations.length ?? 0) > 0 || e.affiliation) && item("소속", e.affiliation)}
          {item("성명", e.name)}
          <div>
            <dt>주민등록번호</dt>
            <dd className={`hr-mono ${e.has_rrn ? "" : "is-empty"}`}>{rrn || e.rrn_masked || "·"}</dd>
          </div>
          {item("생년월일", e.birth_date ? `${e.birth_date}${age != null ? ` (만 ${age}세)` : ""}` : "")}
          {item("성별", e.gender ? `${e.gender}${e.foreigner ? " · 외국인" : ""}` : "")}
          {item("연락처", e.phone)}
          {item("비상 연락처", e.emergency)}
          {item("주소", e.address, true)}
        </dl>
      </section>

      <section className="hr-card-sec">
        <h2>고용</h2>
        <dl className="hr-dl">
          {item("입사일", e.hire_date)}
          {item("근속", tenureText(e.hire_date, e.leave_date && e.leave_date < today ? e.leave_date : today))}
          {item("고용 형태", e.emp_type)}
          {item("부서", e.dept)}
          {item("직위", e.position)}
          {item("업무", e.job)}
          {item("계약 기간", e.contract_start || e.contract_end ? `${e.contract_start || ""} ~ ${e.contract_end || ""}` : "")}
          {item("퇴사일", e.leave_date)}
          {item("퇴사 사유", e.leave_reason)}
          {item("이력", e.career, true)}
        </dl>
      </section>

      <section className="hr-card-sec">
        <h2>근로 조건</h2>
        <dl className="hr-dl">
          {item("급여 형태", PAY_TYPE_LABEL[e.pay_type])}
          {item(e.pay_type === "hourly" ? "시급" : "월급", nowWage ? `${numText(e.pay_type === "hourly" ? nowWage.hourly_wage : nowWage.monthly_wage)}원` : "")}
          {item("소정근로 요일", workDaysText(e.work_days))}
          {item("근무 시각", `${e.work_start} ~ ${e.work_end}`)}
          {item("휴게", `${e.break_min}분`)}
          {item("하루 소정근로시간", `${e.daily_hours}시간`)}
        </dl>
        <div className="b2b-table-wrap">
          <table className="b2b-table hr-table">
            <thead><tr><th>임금 적용 시작일</th><th className="num">시급</th><th className="num">월급</th><th>비고</th><th className="hr-noprint"></th></tr></thead>
            <tbody>
              {e.wages.map((w) => (
                <tr key={w.id}>
                  <td>{w.effective_from}{nowWage?.id === w.id && <span className="b2b-status-pill hr-pill-off" style={{ marginLeft: 8 }}>지금</span>}</td>
                  <td className="num">{w.hourly_wage ? `${numText(w.hourly_wage)}원` : ""}</td>
                  <td className="num">{w.monthly_wage ? `${numText(w.monthly_wage)}원` : ""}</td>
                  <td>{w.note}</td>
                  <td className="actions hr-noprint">
                    {e.wages.length > 1 && <button type="button" className="b2b-link-btn" onClick={() => removeWage(w)}>임금 줄 삭제</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="hr-card-sec">
        <h2>세금·4대보험</h2>
        <dl className="hr-dl">
          {item("공제대상가족 수", `${e.dependents}명`)}
          {item("8~20세 자녀 수", `${e.children}명`)}
          {item("원천징수 비율", `${e.tax_rate}%`)}
          {item("국민연금", yn(e.ins_pension))}
          {item("건강보험·장기요양", yn(e.ins_health))}
          {item("고용보험", yn(e.ins_employment))}
          {item("국민연금·건강보험 기준", e.ins_basis === "notice" ? "공단 고지" : "그달 급여")}
          {item("국민연금 기준소득월액", e.ins_basis === "notice" && e.pension_base ? `${numText(e.pension_base)}원` : "")}
          {item("건강보험 보수월액", e.ins_basis === "notice" && e.health_base ? `${numText(e.health_base)}원` : "")}
        </dl>
      </section>

      <section className="hr-card-sec">
        <h2>지급·기타</h2>
        <dl className="hr-dl">
          {item("은행", e.bank)}
          {item("계좌번호", e.account_no)}
          {item("예금주", e.account_holder)}
          {item("연차 기준", e.leave_basis ? LEAVE_BASIS_LABEL[e.leave_basis] : wp ? `${LEAVE_BASIS_LABEL[wp.leave_basis]} (사업장 기본값)` : "")}
          {item("메모", e.memo, true)}
        </dl>
      </section>

      <LinkField employeeId={e.id} name={e.name} hasRrn={e.has_rrn} />

      {formOpen && (
        <EmployeeForm employee={e} workplaces={workplaces} minWage={minWage} keyReady={keyReady}
          onClose={() => setFormOpen(false)}
          onSaved={(saved, note) => {
            setFormOpen(false); setE(saved); setRrn(null);
            if (note) toast.error(note); else toast.success(`${saved.name} 정보를 저장했습니다`);
          }} />
      )}
    </div>
  );
}
