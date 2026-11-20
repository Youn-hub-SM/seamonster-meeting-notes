"use client";

// 요율 — 적용 시작일별 4대보험 요율·최저임금·세액표 자녀 공제·비과세 한도.
//  급여를 계산할 때 그 달(또는 지급일)에 유효한 줄을 쓴다. '확인 전' = 고시·법령 원문과 아직 대조하지 않은 값.

import { useCallback, useEffect, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { numText, rateOn, rateText, todayKst, type Rate } from "@/app/lib/hr";
import { HrApiError, errText, hrApi } from "../api";

type Field = { k: keyof Rate; label: string; kind: "pct" | "won" };
const GROUPS: { title: string; fields: Field[] }[] = [
  { title: "국민연금", fields: [
    { k: "pension_rate", label: "요율(%) 전체", kind: "pct" },
    { k: "pension_min", label: "기준소득월액 하한", kind: "won" },
    { k: "pension_max", label: "기준소득월액 상한", kind: "won" },
  ] },
  { title: "건강보험·장기요양", fields: [
    { k: "health_rate", label: "건강보험 요율(%) 전체", kind: "pct" },
    { k: "health_min_premium", label: "근로자 몫 보험료 하한", kind: "won" },
    { k: "health_max_premium", label: "근로자 몫 보험료 상한", kind: "won" },
    { k: "ltc_rate", label: "장기요양 요율(%) 전체", kind: "pct" },
  ] },
  { title: "고용보험·최저임금", fields: [
    { k: "employ_rate", label: "고용보험 근로자 요율(%)", kind: "pct" },
    { k: "employ_employer_rate", label: "고용보험 사업주 요율(%)", kind: "pct" },
    { k: "min_wage", label: "최저임금(시급)", kind: "won" },
  ] },
  { title: "소득세 자녀 공제(8~20세)", fields: [
    { k: "child_credit_1", label: "1명", kind: "won" },
    { k: "child_credit_2", label: "2명", kind: "won" },
    { k: "child_credit_more", label: "3명부터 1명당 추가", kind: "won" },
  ] },
  { title: "비과세 월 한도", fields: [
    { k: "meal_limit", label: "식대", kind: "won" },
    { k: "car_limit", label: "자가운전보조금", kind: "won" },
    { k: "childcare_limit", label: "보육수당(자녀 1명당)", kind: "won" },
  ] },
];
const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

export default function HrRatesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rates, setRates] = useState<Rate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ rate: Rate | null; base: Rate | null } | null>(null);
  const today = todayKst();

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setRates((await hrApi<{ rates: Rate[] }>("/api/hr/rates")).rates); }
    catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "요율을 불러오지 못했습니다.")); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const nowId = rateOn(rates, today)?.id;

  async function toggleChecked(r: Rate) {
    try {
      const j = await hrApi<{ rate: Rate }>("/api/hr/rates", "PATCH", { id: r.id, checked: !r.checked });
      setRates((p) => p.map((x) => (x.id === r.id ? j.rate : x)));
    } catch (err) { toast.error(errText(err, "요율을 저장하지 못했습니다.")); }
  }
  async function remove(r: Rate) {
    const ok = await confirm({ title: `${r.effective_from} 요율 삭제`, body: "이 날짜부터의 급여 계산이 앞 줄의 요율을 쓰게 됩니다. 이미 확정한 급여는 바뀌지 않습니다.", action: "요율 삭제" });
    if (!ok) return;
    try {
      await hrApi(`/api/hr/rates?id=${r.id}`, "DELETE");
      setRates((p) => p.filter((x) => x.id !== r.id));
      toast.success("요율을 삭제했습니다");
    } catch (err) { toast.error(errText(err, "요율을 삭제하지 못했습니다.")); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">요율</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-primary" disabled={loading || !!error} onClick={() => setEdit({ rate: null, base: rates[0] || null })}>요율 추가</button>
        </div>
      </header>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error ? null : rates.length === 0 ? (
        <div className="b2b-empty">
          등록된 요율이 없습니다.
          <div className="b2b-empty-action"><button type="button" className="b2b-btn-secondary" onClick={() => setEdit({ rate: null, base: null })}>요율 추가</button></div>
        </div>
      ) : (
        <>
          <p className="hr-rule">4대보험·최저임금은 귀속월, 소득세 자녀 공제는 지급일에 유효한 줄을 씁니다. 요율은 전체(근로자 + 회사) 기준이고 근로자 몫은 절반입니다.</p>
          <div className="b2b-table-wrap">
            <table className="b2b-table hr-table">
              <thead>
                <tr>
                  <th>적용 시작일</th><th className="num">국민연금</th><th className="num">기준소득월액</th><th className="num">건강보험</th><th className="num">장기요양</th>
                  <th className="num">고용보험</th><th className="num">최저임금</th><th className="num">자녀 공제</th><th>원문 대조</th><th>비고</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.id}>
                    <td>{r.effective_from}{r.id === nowId && <span className="b2b-status-pill hr-pill-off" style={{ marginLeft: 8 }}>지금</span>}</td>
                    <td className="num">{rateText(r.pension_rate)}%</td>
                    <td className="num">{numText(r.pension_min)} ~ {numText(r.pension_max)}</td>
                    <td className="num">{rateText(r.health_rate)}%</td>
                    <td className="num">{rateText(r.ltc_rate)}%</td>
                    <td className="num">{rateText(r.employ_rate)}%</td>
                    <td className="num">{numText(r.min_wage)}원</td>
                    <td className="num">{numText(r.child_credit_1)} / {numText(r.child_credit_2)} / +{numText(r.child_credit_more)}</td>
                    <td>
                      <span className={`b2b-status-pill ${r.checked ? "hr-pill-ok" : "hr-pill-off"}`}>{r.checked ? "확인함" : "확인 전"}</span>
                    </td>
                    <td style={{ whiteSpace: "normal", minWidth: 240 }}>{r.note}</td>
                    <td className="actions">
                      <button type="button" className="b2b-link-btn" onClick={() => toggleChecked(r)}>{r.checked ? "확인 취소" : "원문 확인"}</button>
                      <button type="button" className="b2b-link-btn" onClick={() => setEdit({ rate: r, base: r })}>요율 수정</button>
                      {rates.length > 1 && <button type="button" className="b2b-link-btn" onClick={() => remove(r)}>요율 삭제</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {edit && (
        <RateForm rate={edit.rate} base={edit.base} onClose={() => setEdit(null)}
          onSaved={(saved) => {
            setEdit(null);
            setRates((p) => [...p.filter((x) => x.id !== saved.id), saved].sort((a, b) => b.effective_from.localeCompare(a.effective_from)));
            toast.success(edit.rate ? "요율을 저장했습니다" : "요율을 추가했습니다");
          }} />
      )}
    </div>
  );
}

// 요율 추가·수정 — 추가는 가장 최근 줄의 값을 채운 채 열어 바뀐 칸만 고친다
function RateForm({ rate, base, onClose, onSaved }: { rate: Rate | null; base: Rate | null; onClose: () => void; onSaved: (r: Rate) => void }) {
  const [f, setF] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = { effective_from: rate?.effective_from || "", note: rate?.note || "" };
    for (const { k } of ALL_FIELDS) o[k] = base ? String(base[k]) : "";
    return o;
  });
  const [checked, setChecked] = useState(rate?.checked ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);

  async function save() {
    if (!f.effective_from) { setErrors({ effective_from: "적용 시작일을 입력하세요" }); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError(""); setErrors({});
    try {
      const body = { ...f, checked, ...(rate ? { id: rate.id } : {}) };
      const j = await hrApi<{ rate: Rate }>("/api/hr/rates", rate ? "PATCH" : "POST", body);
      onSaved(j.rate);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("요율을 저장하지 못했습니다.");
      setBusy(false);
    }
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label={rate ? "요율 수정" : "요율 추가"}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{rate ? `${rate.effective_from} 요율 수정` : "요율 추가"}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <label className="b2b-field">
                <span className="b2b-field-label">적용 시작일<span className="req">*</span></span>
                <input className="b2b-input" type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} aria-invalid={errors.effective_from ? "true" : undefined} />
                {errors.effective_from && <span className="b2b-field-error">{errors.effective_from}</span>}
              </label>
            </section>
            {GROUPS.map((g) => (
              <section key={g.title} className="hr-form-sec">
                <h3>{g.title}</h3>
                {g.fields.map(({ k, label, kind }) => (
                  <label key={k} className="b2b-field">
                    <span className="b2b-field-label">{label}</span>
                    <input className="b2b-input num" inputMode={kind === "pct" ? "decimal" : "numeric"}
                      value={kind === "won" && f[k] ? Number(f[k]).toLocaleString("ko-KR") : f[k]}
                      onChange={(e) => setF({ ...f, [k]: kind === "won" ? e.target.value.replace(/[^\d]/g, "") : e.target.value.replace(/[^\d.]/g, "") })}
                      aria-invalid={errors[k] ? "true" : undefined} />
                    {errors[k] && <span className="b2b-field-error">{errors[k]}</span>}
                  </label>
                ))}
              </section>
            ))}
            <section className="hr-form-sec">
              <label className="b2b-field hr-wide">
                <span className="b2b-field-label">비고</span>
                <textarea className="b2b-input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} />
              </label>
              <div className="hr-checks hr-wide">
                <label><input type="checkbox" className="b2b-checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />고시·법령 원문과 대조함</label>
              </div>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : rate ? "변경 저장" : "요율 추가"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
