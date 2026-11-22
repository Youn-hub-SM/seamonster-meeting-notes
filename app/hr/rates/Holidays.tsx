"use client";

// 공휴일(쉬는 날) 목록 — 근무대장의 [평소대로 채우기]가 이 날을 '유급 휴일'로 채우고, 연차 사용 등록이 이 날을 건너뛴다.
//  처음 값(2026·2027년)은 hr/007 이 넣는다. 임시공휴일·회사 휴일은 여기서 더하고, 틀린 날은 지운다.

import { useCallback, useEffect, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { WEEKDAYS, isDate, todayKst } from "@/app/lib/hr";
import { weekdayOf } from "@/app/lib/hr-work";
import { FIXED_HOLIDAYS, type Holiday } from "@/app/lib/hr-holidays";
import { HrApiError, errText, hrApi } from "../api";

export default function Holidays() {
  const toast = useToast();
  const confirm = useConfirm();
  const [year, setYear] = useState(Number(todayKst().slice(0, 4)));
  const [list, setList] = useState<Holiday[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "pending" | "error">("loading");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const j = await hrApi<{ holidays: Holiday[]; pending: boolean }>(`/api/hr/holidays?year=${year}`);
      setList(j.holidays); setState(j.pending ? "pending" : "ready");
    } catch (err) {
      if (err instanceof HrApiError && err.status === 401) return;
      setNote(errText(err, "공휴일을 불러오지 못했습니다.")); setState(err instanceof HrApiError && err.pending ? "pending" : "error");
    }
  }, [year]);
  useEffect(() => { load(); }, [load]);

  // 날짜가 정해진 공휴일 가운데 이 해에 아직 없는 것이 있으면 [정해진 공휴일 넣기]를 보인다
  const missingFixed = FIXED_HOLIDAYS.filter(([md]) => !list.some((h) => h.date === `${year}-${md}`)).length;

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
    const ok = await confirm({ title: `${h.date} ${h.name} 삭제`, body: "이 날을 쉬는 날에서 뺍니다. 이미 근무대장에 저장한 '유급 휴일' 줄은 바뀌지 않습니다.", action: "공휴일 삭제" });
    if (!ok) return;
    try {
      await hrApi(`/api/hr/holidays?date=${h.date}`, "DELETE");
      setList((p) => p.filter((x) => x.date !== h.date));
      toast.success("공휴일을 삭제했습니다");
    } catch (err) { toast.error(errText(err, "공휴일을 지우지 못했습니다.")); }
  }

  return (
    <section className="hr-sec">
      <div className="hr-sec-head">
        <h2>공휴일</h2>
        <div className="hr-filters hr-holiday-nav">
          <button type="button" className="b2b-btn-secondary" onClick={() => setYear((y) => y - 1)}>이전 해</button>
          <strong>{year}년</strong>
          <button type="button" className="b2b-btn-secondary" onClick={() => setYear((y) => y + 1)}>다음 해</button>
          {state === "ready" && list.length > 0 && missingFixed > 0 && <button type="button" className="b2b-btn-secondary" onClick={fillFixed} disabled={busy}>정해진 공휴일 넣기</button>}
          <button type="button" className="b2b-btn-secondary" onClick={() => setOpen(true)} disabled={state !== "ready"}>공휴일 추가</button>
        </div>
      </div>
      {state === "pending" ? (
        <div className="sm-warn">{note || "DB 준비 전입니다. supabase/migrations/hr/007_holidays.sql 을 적용하세요."}</div>
      ) : state === "error" ? (
        <div className="b2b-error" role="alert">{note}</div>
      ) : state === "loading" ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
        <div className="b2b-empty">
          {year}년에 넣어 둔 공휴일이 없습니다.
          <div className="b2b-empty-action"><button type="button" className="b2b-btn-secondary" onClick={fillFixed} disabled={busy}>정해진 공휴일 넣기</button></div>
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table hr-table">
            <thead><tr><th>날짜</th><th>요일</th><th>이름</th><th>구분</th><th></th></tr></thead>
            <tbody>
              {list.map((h) => (
                <tr key={h.date}>
                  <td>{h.date}</td>
                  <td>{WEEKDAYS[weekdayOf(h.date) - 1]}</td>
                  <td>{h.name}</td>
                  <td>{h.seeded ? "처음 값" : "직접 추가"}</td>
                  <td className="actions"><button type="button" className="b2b-link-btn" onClick={() => remove(h)}>공휴일 삭제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <AddForm year={year} onClose={() => setOpen(false)} onSaved={(d) => { setOpen(false); toast.success(`${d} 을 공휴일에 넣었습니다`); if (Number(d.slice(0, 4)) !== year) setYear(Number(d.slice(0, 4))); else load(); }} />}
    </section>
  );
}

function AddForm({ year, onClose, onSaved }: { year: number; onClose: () => void; onSaved: (date: string) => void }) {
  const today = todayKst();
  const [date, setDate] = useState(Number(today.slice(0, 4)) === year ? today : `${year}-01-01`);
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);

  async function save() {
    const errs: Record<string, string> = {};
    if (!isDate(date)) errs.date = "날짜를 입력하세요";
    if (!name.trim()) errs.name = "이름을 입력하세요";
    if (Object.keys(errs).length > 0) { setErrors(errs); setFormError("입력을 확인하세요."); return; }
    setBusy(true); setFormError(""); setErrors({});
    try {
      await hrApi("/api/hr/holidays", "POST", { date, name });
      onSaved(date);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("공휴일을 저장하지 못했습니다.");
      setBusy(false);
    }
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label="공휴일 추가">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">공휴일 추가</span>
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
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : "공휴일 추가"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
