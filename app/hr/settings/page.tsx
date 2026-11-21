"use client";

// 사업장 — 회사 정보와 급여·연차 계산 기준(5인 이상·주휴·지급일·회사 부담 요율·연차 기준).

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { LEAVE_BASIS_LABEL, LEAVE_ROUND_LABEL, WEEKDAYS, rateText, type Workplace } from "@/app/lib/hr";
import { HrApiError, errText, hrApi } from "../api";
import StampField from "./StampField";

export default function HrSettingsPage() {
  const toast = useToast();
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ wp: Workplace | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setWorkplaces((await hrApi<{ workplaces: Workplace[] }>("/api/hr/workplaces")).workplaces); }
    catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "사업장을 불러오지 못했습니다.")); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  const hasAff = workplaces.some((w) => w.affiliations.length > 0);   // 소속을 쓰는 사업장이 있을 때만 그 열을 보인다

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">사업장</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-primary" disabled={loading || !!error} onClick={() => setEdit({ wp: null })}>사업장 등록</button>
        </div>
      </header>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : workplaces.length === 0 ? (
        <div className="b2b-empty">
          등록된 사업장이 없습니다.
          <div className="b2b-empty-action"><button type="button" className="b2b-btn-secondary" onClick={() => setEdit({ wp: null })}>사업장 등록</button></div>
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table hr-table">
            <thead>
              <tr><th>사업장</th>{hasAff && <th>소속</th>}<th>사업자등록번호</th><th>대표자</th><th>상시 근로자</th><th>주휴수당</th><th>지급일</th><th className="num">산재 요율</th><th>연차 기준</th><th>상태</th><th></th></tr>
            </thead>
            <tbody>
              {workplaces.map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.name}</strong></td>
                  {hasAff && <td>{w.affiliations.join(" · ")}</td>}
                  <td className="hr-mono">{w.biz_no}</td>
                  <td>{w.ceo}</td>
                  <td>{w.five_plus ? "5인 이상" : "5인 미만"}</td>
                  <td>{w.auto_weekly ? "자동 계산" : "계산 안 함"}</td>
                  <td>다음 달 {w.payday}일</td>
                  <td className="num">{rateText(w.accident_rate)}%</td>
                  <td>{LEAVE_BASIS_LABEL[w.leave_basis]}{w.leave_basis === "fiscal" ? ` (${w.fiscal_start} 시작)` : ""}</td>
                  <td><span className={`b2b-status-pill ${w.active ? "hr-pill-ok" : "hr-pill-off"}`}>{w.active ? "사용" : "중지"}</span></td>
                  <td className="actions"><button type="button" className="b2b-link-btn" onClick={() => setEdit({ wp: w })}>사업장 수정</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <WorkplaceForm wp={edit.wp} onClose={() => setEdit(null)}
          onSaved={(saved) => {
            setEdit(null);
            setWorkplaces((p) => (p.some((x) => x.id === saved.id) ? p.map((x) => (x.id === saved.id ? saved : x)) : [...p, saved]));
            toast.success(edit.wp ? "사업장을 저장했습니다" : "사업장을 등록했습니다");
          }} />
      )}
    </div>
  );
}

function WorkplaceForm({ wp, onClose, onSaved }: { wp: Workplace | null; onClose: () => void; onSaved: (w: Workplace) => void }) {
  const [f, setF] = useState({
    name: wp?.name || "", biz_no: wp?.biz_no || "", ceo: wp?.ceo || "", address: wp?.address || "", phone: wp?.phone || "",
    affiliations: (wp?.affiliations || []).join(", "),   // 소속 목록 — 쉼표로 나눠 적는다(서버가 이름 목록으로 바꾼다)
    five_plus: wp?.five_plus ?? true, auto_weekly: wp?.auto_weekly ?? true, active: wp?.active ?? true,
    week_start: String(wp?.week_start ?? 1), weekly_pay_month: wp?.weekly_pay_month || "end",
    payday: String(wp?.payday ?? 10), accident_rate: wp ? rateText(wp.accident_rate) : "", employ_extra_rate: wp ? rateText(wp.employ_extra_rate) : "0.25",
    fiscal_start: wp?.fiscal_start || "01-01", leave_basis: wp?.leave_basis || "fiscal", leave_round: wp?.leave_round || "ceil_half",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!f.name.trim()) { setErrors({ name: "사업장 이름을 입력하세요" }); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError(""); setErrors({});
    try {
      const j = await hrApi<{ workplace: Workplace }>("/api/hr/workplaces", wp ? "PATCH" : "POST", { ...f, ...(wp ? { id: wp.id } : {}) });
      onSaved(j.workplace);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("사업장을 저장하지 못했습니다.");
      setBusy(false);
    }
  }
  const err = (k: string) => (errors[k] ? <span className="b2b-field-error">{errors[k]}</span> : null);
  const inv = (k: string) => (errors[k] ? ("true" as const) : undefined);
  const text = (k: "name" | "biz_no" | "ceo" | "address" | "phone" | "affiliations" | "payday" | "accident_rate" | "employ_extra_rate" | "fiscal_start", label: string, o?: { req?: boolean; cls?: string; ph?: string; num?: boolean }) => (
    <label className={`b2b-field ${o?.cls || ""}`}>
      <span className="b2b-field-label">{label}{o?.req && <span className="req">*</span>}</span>
      <input className={`b2b-input ${o?.num ? "num" : ""}`} value={f[k]} placeholder={o?.ph} inputMode={o?.num ? "decimal" : undefined}
        onChange={(e) => set(k, o?.num ? e.target.value.replace(/[^\d.]/g, "") : e.target.value)} aria-invalid={inv(k)} />
      {err(k)}
    </label>
  );

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label={wp ? "사업장 수정" : "사업장 등록"}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{wp ? `${wp.name} 수정` : "사업장 등록"}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <h3>회사</h3>
              {text("name", "사업장 이름", { req: true })}
              {text("biz_no", "사업자등록번호", { ph: "000-00-00000" })}
              {text("ceo", "대표자")}
              {text("phone", "전화")}
              {text("address", "주소", { cls: "hr-span2" })}
              {text("affiliations", "소속(쉼표로 나눠 적기)", { cls: "hr-wide", ph: "파도소리, 엄마와 바다" })}
            </section>
            <section className="hr-form-sec">
              <h3>급여</h3>
              <div className="b2b-field hr-wide">
                <div className="hr-checks">
                  <label><input type="checkbox" className="b2b-checkbox" checked={f.five_plus} onChange={(e) => set("five_plus", e.target.checked)} />상시 근로자 5인 이상</label>
                  <label><input type="checkbox" className="b2b-checkbox" checked={f.auto_weekly} onChange={(e) => set("auto_weekly", e.target.checked)} />주휴수당 자동 계산</label>
                  {wp && <label><input type="checkbox" className="b2b-checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />사용</label>}
                </div>
                {!f.five_plus && <span className="hr-field-note">5인 미만 — 연장·야간·휴일 가산과 법정 연차를 계산하지 않습니다</span>}
              </div>
              {text("payday", "지급일(다음 달)", { num: true })}
              <label className="b2b-field">
                <span className="b2b-field-label">주의 첫 요일</span>
                <select className="b2b-input" value={f.week_start} onChange={(e) => set("week_start", e.target.value)}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}요일</option>)}
                </select>
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">달이 바뀌는 주의 주휴수당</span>
                <select className="b2b-input" value={f.weekly_pay_month} onChange={(e) => set("weekly_pay_month", e.target.value as "end" | "start")}>
                  <option value="end">주가 끝나는 달에</option>
                  <option value="start">주가 시작하는 달에</option>
                </select>
              </label>
              {text("accident_rate", "산재보험 요율(%)", { num: true, ph: "0" })}
              {text("employ_extra_rate", "고용안정·직업능력 요율(%)", { num: true })}
            </section>
            <section className="hr-form-sec">
              <h3>연차</h3>
              <label className="b2b-field">
                <span className="b2b-field-label">연차 기준</span>
                <select className="b2b-input" value={f.leave_basis} onChange={(e) => set("leave_basis", e.target.value as "hire" | "fiscal")}>
                  <option value="fiscal">회계연도 기준</option>
                  <option value="hire">입사일 기준</option>
                </select>
              </label>
              {text("fiscal_start", "회계연도 첫날(월-일)", { ph: "01-01" })}
              <label className="b2b-field">
                <span className="b2b-field-label">비례 연차 소수점</span>
                <select className="b2b-input" value={f.leave_round} onChange={(e) => set("leave_round", e.target.value as Workplace["leave_round"])}>
                  {(Object.keys(LEAVE_ROUND_LABEL) as Workplace["leave_round"][]).map((k) => <option key={k} value={k}>{LEAVE_ROUND_LABEL[k]}</option>)}
                </select>
              </label>
            </section>
            {wp && <StampField workplaceId={wp.id} />}
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : wp ? "변경 저장" : "사업장 등록"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
