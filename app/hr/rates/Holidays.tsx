"use client";

// 쉬는 날(공휴일·휴무일) 목록 — 근무대장의 [평소대로 채우기]가 이 날을 '유급 휴일'·'무급 휴무'로 채우고, 연차 사용 등록이 이 날을 건너뛴다.
//  처음 값(2026·2027년 공휴일)은 hr/007 이 넣는다. 임시공휴일·회사 휴무일은 여기서 더하고, 틀린 날은 지운다.
//  구분(공휴일 / 유급 휴무일 / 무급 휴무일)과 적용 범위(전체 / 사업장 / 소속)는 hr/008 을 적용한 뒤에 고를 수 있다.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { WEEKDAYS, isDate, todayKst } from "@/app/lib/hr";
import { weekdayOf } from "@/app/lib/hr-work";
import { FIXED_HOLIDAYS, HOLIDAY_KINDS, HOLIDAY_KIND_LABEL, scopeText, type Holiday, type HolidayKind, type HolidayWorkplace } from "@/app/lib/hr-holidays";
import { HrApiError, errText, hrApi } from "../api";

type Loaded = { holidays: Holiday[]; pending: boolean; extended?: boolean; workplaces?: HolidayWorkplace[] };

export default function Holidays() {
  const toast = useToast();
  const confirm = useConfirm();
  const [year, setYear] = useState(Number(todayKst().slice(0, 4)));
  const [list, setList] = useState<Holiday[]>([]);
  const [workplaces, setWorkplaces] = useState<HolidayWorkplace[]>([]);
  const [extended, setExtended] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "pending" | "error">("loading");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const j = await hrApi<Loaded>(`/api/hr/holidays?year=${year}`);
      setList(j.holidays); setWorkplaces(j.workplaces || []); setExtended(!!j.extended); setState(j.pending ? "pending" : "ready");
    } catch (err) {
      if (err instanceof HrApiError && err.status === 401) return;
      setNote(errText(err, "공휴일을 불러오지 못했습니다.")); setState(err instanceof HrApiError && err.pending ? "pending" : "error");
    }
  }, [year]);
  useEffect(() => { load(); }, [load]);

  // 날짜가 정해진 공휴일 가운데 이 해에 아직 없는 것이 있으면 [정해진 공휴일 넣기]를 보인다(전체에 적용되는 줄만 센다)
  const missingFixed = FIXED_HOLIDAYS.filter(([md]) => !list.some((h) => !h.workplace_id && h.date === `${year}-${md}`)).length;

  async function fillFixed() {
    setBusy(true);
    try {
      const j = await hrApi<{ added: number }>("/api/hr/holidays", "POST", { action: "fill_fixed", year });
      toast.success(`${year}년 공휴일 ${j.added}일을 넣었습니다`);
      await load();
    } catch (err) { toast.error(errText(err, "공휴일을 넣지 못했습니다.")); }
    setBusy(false);
  }
  async function remove(h: Holiday) {
    const word = h.kind === "public" ? "공휴일" : "휴무일";
    const ok = await confirm({ title: `${h.date} ${h.name} 삭제`, body: "이 날을 쉬는 날에서 뺍니다. 이미 근무대장에 저장한 줄은 바뀌지 않습니다.", action: `${word} 삭제` });
    if (!ok) return;
    try {
      await hrApi(`/api/hr/holidays?id=${encodeURIComponent(h.id)}`, "DELETE");
      setList((p) => p.filter((x) => x.id !== h.id));
      toast.success(`${word}을 삭제했습니다`);
    } catch (err) { toast.error(errText(err, "쉬는 날을 지우지 못했습니다.")); }
  }

  return (
    <section className="hr-sec">
      <div className="hr-sec-head">
        <h2>공휴일·휴무일</h2>
        <div className="hr-filters hr-holiday-nav">
          <button type="button" className="b2b-btn-secondary" onClick={() => setYear((y) => y - 1)}>이전 해</button>
          <strong>{year}년</strong>
          <button type="button" className="b2b-btn-secondary" onClick={() => setYear((y) => y + 1)}>다음 해</button>
          {state === "ready" && list.length > 0 && missingFixed > 0 && <button type="button" className="b2b-btn-secondary" onClick={fillFixed} disabled={busy}>정해진 공휴일 넣기</button>}
          <button type="button" className="b2b-btn-secondary" onClick={() => setOpen(true)} disabled={state !== "ready"}>공휴일·휴무일 추가</button>
        </div>
      </div>
      {state === "ready" && !extended && <div className="sm-warn">무급 휴무일과 사업장·소속별 휴무일을 넣으려면 supabase/migrations/hr/008_holiday_kinds.sql 을 적용하세요.</div>}
      {state === "pending" ? (
        <div className="sm-warn">{note || "DB 준비 전입니다. supabase/migrations/hr/007_holidays.sql 을 적용하세요."}</div>
      ) : state === "error" ? (
        <div className="b2b-error" role="alert">{note}</div>
      ) : state === "loading" ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
        <div className="b2b-empty">
          {year}년에 넣어 둔 공휴일·휴무일이 없습니다.
          <div className="b2b-empty-action"><button type="button" className="b2b-btn-secondary" onClick={fillFixed} disabled={busy}>정해진 공휴일 넣기</button></div>
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table hr-table">
            <thead><tr><th>날짜</th><th>요일</th><th>이름</th>{extended && <><th>구분</th><th>적용</th></>}<th></th></tr></thead>
            <tbody>
              {list.map((h) => (
                <tr key={h.id}>
                  <td>{h.date}</td>
                  <td>{WEEKDAYS[weekdayOf(h.date) - 1]}</td>
                  <td>{h.name}</td>
                  {extended && <><td>{HOLIDAY_KIND_LABEL[h.kind]}</td><td>{scopeText(h, workplaces)}</td></>}
                  <td className="actions"><button type="button" className="b2b-link-btn" onClick={() => remove(h)}>{h.kind === "public" ? "공휴일 삭제" : "휴무일 삭제"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <AddForm year={year} extended={extended} workplaces={workplaces} onClose={() => setOpen(false)}
          onSaved={(d) => { setOpen(false); toast.success(`${d} 을 쉬는 날에 넣었습니다`); if (Number(d.slice(0, 4)) !== year) setYear(Number(d.slice(0, 4))); else load(); }} />
      )}
    </section>
  );
}

// 적용 범위 고르기의 한 줄: 값은 "사업장 id|소속"(전체는 빈 값)
type ScopeOption = { value: string; label: string; workplace_id: string; affiliation: string };
function scopeOptions(workplaces: HolidayWorkplace[]): ScopeOption[] {
  const multi = workplaces.length > 1;
  const out: ScopeOption[] = [{ value: "", label: "전체", workplace_id: "", affiliation: "" }];
  for (const w of workplaces) {
    if (multi) out.push({ value: `${w.id}|`, label: w.name, workplace_id: w.id, affiliation: "" });
    for (const a of w.affiliations) out.push({ value: `${w.id}|${a}`, label: multi ? `${w.name} · ${a}` : a, workplace_id: w.id, affiliation: a });
  }
  return out;
}

function AddForm({ year, extended, workplaces, onClose, onSaved }: { year: number; extended: boolean; workplaces: HolidayWorkplace[]; onClose: () => void; onSaved: (date: string) => void }) {
  const today = todayKst();
  const [date, setDate] = useState(Number(today.slice(0, 4)) === year ? today : `${year}-01-01`);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<HolidayKind>("public");
  const [scope, setScope] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);
  const scopes = useMemo(() => scopeOptions(workplaces), [workplaces]);

  async function save() {
    const errs: Record<string, string> = {};
    if (!isDate(date)) errs.date = "날짜를 입력하세요";
    if (!name.trim()) errs.name = "이름을 입력하세요";
    if (Object.keys(errs).length > 0) { setErrors(errs); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError(""); setErrors({});
    try {
      const picked = scopes.find((s) => s.value === scope) || scopes[0];
      await hrApi("/api/hr/holidays", "POST", extended ? { date, name, kind, workplace_id: picked.workplace_id, affiliation: picked.affiliation } : { date, name });
      onSaved(date);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("쉬는 날을 저장하지 못했습니다.");
      setBusy(false);
    }
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label="공휴일·휴무일 추가">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">공휴일·휴무일 추가</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <label className="b2b-field">
                <span className="b2b-field-label">날짜<span className="req">*</span></span>
                <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={errors.date ? "true" : undefined} />
                {errors.date && <span className="b2b-field-error">{errors.date}</span>}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">이름<span className="req">*</span></span>
                <input className="b2b-input" value={name} maxLength={40} placeholder="임시공휴일" onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? "true" : undefined} />
                {errors.name && <span className="b2b-field-error">{errors.name}</span>}
              </label>
              {extended && (
                <div className="b2b-field hr-wide">
                  <span className="b2b-field-label">구분</span>
                  <div className="sm-tabs">
                    {HOLIDAY_KINDS.map((k) => (
                      <button key={k} type="button" className={`sm-tab ${kind === k ? "is-active" : ""}`} onClick={() => setKind(k)}>{HOLIDAY_KIND_LABEL[k]}</button>
                    ))}
                  </div>
                  {errors.kind && <span className="b2b-field-error">{errors.kind}</span>}
                </div>
              )}
              {extended && scopes.length > 1 && (
                <label className="b2b-field hr-wide">
                  <span className="b2b-field-label">적용</span>
                  <select className="b2b-input" value={scope} onChange={(e) => setScope(e.target.value)} aria-invalid={errors.scope ? "true" : undefined}>
                    {scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  {errors.scope && <span className="b2b-field-error">{errors.scope}</span>}
                </label>
              )}
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : "공휴일·휴무일 추가"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
