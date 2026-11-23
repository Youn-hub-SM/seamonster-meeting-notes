"use client";

// 미리 적기 — "오늘 못 찍었어요"를 들은 날 적어 두는 창. 세콤 파일을 넣을 때 그날 줄에 붙어, 빈 시각을 이 시각으로 채우자고 나온다.
//  근무대장에 바로 들어가는 것이 아니다(근무대장은 파일을 넣고 보정할 때 채워진다).

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { monthRange } from "@/app/lib/hr-work";
import { NOTE_KINDS, NOTE_KIND_LABEL, dayLabel, type NoteKind, type PunchNote } from "@/app/lib/hr-punch";
import { HrApiError, errText, hrApi } from "../api";

type Person = { id: string; name: string; workplace: string };
const blank = (date: string) => ({ employee_id: "", work_date: date, kind: "both" as NoteKind, in_time: "", out_time: "", memo: "" });

export default function PunchNotes({ month, today, people, onClose }: { month: string; today: string; people: Person[]; onClose: () => void }) {
  const toast = useToast();
  const [notes, setNotes] = useState<PunchNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(blank(today.startsWith(month) ? today : `${month}-01`));
  useEscClose(onClose, busy);
  const range = monthRange(month);

  const load = useCallback(async () => {
    setLoading(true);
    try { setNotes((await hrApi<{ notes: PunchNote[] }>(`/api/hr/attendance/notes?month=${month}`)).notes); setError(""); }
    catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "미리 적은 것을 불러오지 못했습니다.")); }
    setLoading(false);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const nameOf = (id: string) => { const p = people.find((x) => x.id === id); return p ? `${p.name}${p.workplace ? ` · ${p.workplace}` : ""}` : ""; };

  async function add() {
    if (f.work_date < range.from || f.work_date > range.to) { setFields({ work_date: "이 달의 날짜를 넣으세요" }); return; }
    setBusy(true); setError(""); setFields({});
    try {
      await hrApi("/api/hr/attendance/notes", "POST", f);
      setF(blank(f.work_date));
      toast.success("적어 두었습니다");
      await load();
    } catch (err) {
      if (err instanceof HrApiError) setFields(err.fields);
      setError(errText(err, "저장하지 못했습니다."));
    }
    setBusy(false);
  }
  async function remove(n: PunchNote) {
    setBusy(true);
    try { await hrApi(`/api/hr/attendance/notes?id=${n.id}`, "DELETE"); await load(); }
    catch (err) { setError(errText(err, "지우지 못했습니다.")); }
    setBusy(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-wide" role="dialog" aria-modal="true" aria-label="미리 적기">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">미리 적기 — {Number(month.slice(0, 4))}년 {Number(month.slice(5))}월</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {error && <div className="b2b-error" role="alert">{error}</div>}
          <div className="hr-punch-noteform">
            <label className="b2b-field">
              <span className="b2b-field-label">직원<span className="req">*</span></span>
              <select className="b2b-input" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">직원 선택</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.workplace ? ` · ${p.workplace}` : ""}</option>)}
              </select>
              {fields.employee_id && <span className="b2b-field-error">{fields.employee_id}</span>}
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">날짜<span className="req">*</span></span>
              <input type="date" className="b2b-input" value={f.work_date} min={range.from} max={range.to} onChange={(e) => setF({ ...f, work_date: e.target.value })} />
              {fields.work_date && <span className="b2b-field-error">{fields.work_date}</span>}
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">내용</span>
              <select className="b2b-input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as NoteKind })}>
                {NOTE_KINDS.map((k) => <option key={k} value={k}>{NOTE_KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">실제 출근</span>
              <input type="time" className="b2b-input" value={f.in_time} onChange={(e) => setF({ ...f, in_time: e.target.value })} />
              {fields.in_time && <span className="b2b-field-error">{fields.in_time}</span>}
            </label>
            <label className="b2b-field">
              <span className="b2b-field-label">실제 퇴근</span>
              <input type="time" className="b2b-input" value={f.out_time} onChange={(e) => setF({ ...f, out_time: e.target.value })} />
              {fields.out_time && <span className="b2b-field-error">{fields.out_time}</span>}
            </label>
            <label className="b2b-field hr-punch-memo">
              <span className="b2b-field-label">메모</span>
              <input className="b2b-input" value={f.memo} maxLength={200} onChange={(e) => setF({ ...f, memo: e.target.value })} />
            </label>
            <button type="button" className="b2b-btn-primary" onClick={add} disabled={busy || !f.employee_id || !f.work_date}>적어 두기</button>
          </div>

          {loading ? <div className="b2b-loading">불러오는 중...</div> : notes.length === 0 ? <div className="b2b-empty">이 달에 적어 둔 것이 없습니다.</div> : (
            <div className="b2b-table-wrap">
              <table className="b2b-table hr-table">
                <thead><tr><th>날짜</th><th>직원</th><th>내용</th><th>실제 시각</th><th>메모</th><th>적은 사람</th><th></th></tr></thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td className="sm-nowrap">{dayLabel(n.work_date)}</td>
                      <td><strong>{nameOf(n.employee_id)}</strong></td>
                      <td>{NOTE_KIND_LABEL[n.kind]}</td>
                      <td className="sm-nowrap">{n.in_time || n.out_time ? `${n.in_time || "--:--"} ~ ${n.out_time || "--:--"}` : ""}</td>
                      <td>{n.memo}</td>
                      <td>{n.created_by || ""}</td>
                      <td className="actions"><button type="button" className="sm-link" onClick={() => remove(n)} disabled={busy}>지우기</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
