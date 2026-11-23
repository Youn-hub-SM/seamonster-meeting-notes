"use client";

// 세콤 기록 넣기 — 세콤에서 받은 출근 기록 파일로 그 달 근무대장을 채운다: 파일 고르기 → 이름 짝 → 확인할 줄 보정 → 입력 완료.
//  둘 다 찍힌 날은 자동으로 들어가고, 한쪽만 찍혔거나 안 찍힌 날·쉬는 날에 찍힌 날·지각·조퇴·퇴근 뒤 오래 남은 날만 여기서 정한다.
//  계산은 서버가 한다(app/lib/hr-punch.ts 의 규칙) — 화면은 '어떻게 처리할지'만 보낸다. 입력 완료 때 파일을 다시 읽어 다시 계산한다.

import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/app/components/Feedback";
import { todayKst } from "@/app/lib/hr";
import { hoursFromTimes, hoursText, isMonth, isTime } from "@/app/lib/hr-work";
import {
  NOTE_KIND_LABEL, PUNCH_ACTION_LABEL, breakFor, dayLabel, decisionProblem,
  type PunchAction, type PunchCheck, type PunchDecision, type PunchReport,
} from "@/app/lib/hr-punch";
import { HrApiError, errText, hrApi } from "../../api";

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    fr.readAsDataURL(file);
  });
}
const SKIP = "__skip";
type NameEdit = { employee_id: string | null; skip: boolean };
// 처리를 '근무'로 바꿀 때 채울 시각: 찍힌 것 → 미리 적은 것 → 평소 시각
const prefill = (c: PunchCheck, action: PunchAction, old?: PunchDecision | null): PunchDecision => {
  if (action !== "work" && action !== "holiday_work") return { action };
  const start = old?.start || c.proposal?.start || c.in || c.note?.in_time || c.sched.start || "";
  const end = old?.end || c.proposal?.end || c.out || c.note?.out_time || c.sched.end || "";
  return { action, start, end };
};

export default function HrPunchPage() {
  return (
    <Suspense fallback={<div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>}>
      <PunchMain />
    </Suspense>
  );
}

function PunchMain() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const qMonth = params.get("month") || "";
  const month = isMonth(qMonth) ? qMonth : todayKst().slice(0, 7);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [report, setReport] = useState<PunchReport | null>(null);
  const [decisions, setDecisions] = useState<Record<string, PunchDecision>>({});
  const [names, setNames] = useState<Record<string, NameEdit>>({});
  const [settings, setSettings] = useState<{ grace: string; over: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [allNames, setAllNames] = useState(false);
  const [done, setDone] = useState<{ saved: number; failed: string[] } | null>(null);

  const preview = useCallback(async (f: { name: string; b64: string }, over: boolean, keep: Record<string, PunchDecision>) => {
    setBusy(true); setError("");
    try {
      const r = await hrApi<PunchReport>("/api/hr/attendance/import", "POST", { month, name: f.name, file: f.b64, overwrite: over, decisions: keep });
      setReport(r); setNames({}); setDone(null);
      setSettings({ grace: String(r.settings.grace_min), over: String(r.settings.overtime_min) });
      // 사라진 줄의 고르기는 버린다
      const alive = new Set(r.checks.map((c) => c.key));
      setDecisions((p) => Object.fromEntries(Object.entries(p).filter(([k]) => alive.has(k))));
    } catch (e) {
      if (!(e instanceof HrApiError && e.status === 401)) setError(errText(e, "세콤 출근 기록을 읽지 못했습니다."));
    }
    setBusy(false);
  }, [month]);

  async function pick(f: File | null) {
    if (!f) return;
    try {
      const next = { name: f.name, b64: await toBase64(f) };
      setFile(next); setDecisions({});
      await preview(next, overwrite, {});
    } catch (e) { setError(errText(e, "파일을 읽지 못했습니다.")); }
  }

  const decisionOf = useCallback((c: PunchCheck): PunchDecision | null => decisions[c.key] ?? c.proposal, [decisions]);
  const open = useMemo(() => (report ? report.checks.filter((c) => decisionProblem(decisionOf(c))).length : 0), [report, decisionOf]);
  const nameRows = useMemo(() => (report ? report.names.filter((n) => allNames || n.state === "none" || names[n.source]) : []), [report, allNames, names]);
  const unmatched = report ? report.names.filter((n) => n.state === "none").length : 0;
  const nameDirty = Object.keys(names).length > 0;
  const blocked = !report ? "" : report.names.length === 0 ? report.blocked || "이 달에 넣을 줄이 없습니다" : unmatched > 0 || nameDirty ? "이름 짝을 저장하세요" : /이름이 둘 이상/.test(report.blocked) ? report.blocked : open > 0 ? `확인할 줄 ${open}건을 정하세요` : "";

  function setDecision(c: PunchCheck, patch: Partial<PunchDecision>) {
    setDecisions((p) => ({ ...p, [c.key]: { ...(p[c.key] ?? c.proposal ?? { action: "skip" as PunchAction }), ...patch } }));
  }
  function setAction(c: PunchCheck, action: string) {
    setDecisions((p) => {
      const next = { ...p };
      if (!action) delete next[c.key]; else next[c.key] = prefill(c, action as PunchAction, p[c.key]);
      return next;
    });
  }

  async function saveNames() {
    if (!file || !report) return;
    setBusy(true); setError("");
    try {
      await hrApi("/api/hr/attendance/setup", "PUT", { names: Object.entries(names).map(([source_name, v]) => ({ source_name, employee_id: v.employee_id, skip: v.skip })) });
      await preview(file, overwrite, decisions);
    } catch (e) { setError(errText(e, "이름 짝을 저장하지 못했습니다.")); setBusy(false); }
  }
  async function saveSettings() {
    if (!settings) return;
    setBusy(true); setError("");
    try {
      await hrApi("/api/hr/attendance/setup", "PUT", { settings: { grace_min: Number(settings.grace), overtime_min: Number(settings.over) } });
      if (file) await preview(file, overwrite, decisions); else setBusy(false);
      toast.success("기준을 저장했습니다");
    } catch (e) { setError(errText(e, "기준을 저장하지 못했습니다.")); setBusy(false); }
  }
  async function apply() {
    if (!file || !report || blocked) { if (blocked) toast.error(blocked); return; }
    setBusy(true); setError("");
    try {
      const sent: Record<string, PunchDecision> = {};
      for (const c of report.checks) { const d = decisionOf(c); if (d) sent[c.key] = d; }
      const r = await hrApi<PunchReport & { saved: number }>("/api/hr/attendance/import", "POST", { month, name: file.name, file: file.b64, overwrite, decisions: sent, apply: true });
      setReport(r); setDone({ saved: r.saved, failed: r.failed });
      if (r.failed.length > 0) toast.error(`${r.failed.length}명의 근무대장을 넣지 못했습니다`); else toast.success(`근무 ${r.counts.add + r.counts.change}일을 넣었습니다`);
    } catch (e) { setError(errText(e, "세콤 출근 기록을 넣지 못했습니다.")); }
    setBusy(false);
  }

  const settingsDirty = !!report && !!settings && (settings.grace !== String(report.settings.grace_min) || settings.over !== String(report.settings.overtime_min));
  const title = `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;

  return (
    <div className="b2b-container">
      <Link href={`/hr/work?month=${month}`} prefetch={false} className="sm-link hr-back">근무대장</Link>
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">세콤 기록 넣기 — {title}</h1></div>
        <div className="b2b-page-actions">
          {done ? <button type="button" className="b2b-btn-primary" onClick={() => router.push(`/hr/work?month=${month}`)}>근무대장으로</button>
            : <button type="button" className="b2b-btn-primary" onClick={apply} disabled={busy || !report || !!blocked}>{busy ? "처리 중..." : "입력 완료"}</button>}
        </div>
      </header>

      <div className="hr-filters">
        <input type="month" className="b2b-input hr-month" value={month} aria-label="달" disabled={busy} onChange={(e) => { if (isMonth(e.target.value)) { setReport(null); setFile(null); setDone(null); router.push(`/hr/work/punch?month=${e.target.value}`); } }} />
        <input ref={fileRef} type="file" accept=".xlsx" hidden aria-label="세콤 출근 기록 파일" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; pick(f); }} />
        <button type="button" className="b2b-btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>세콤 파일 고르기</button>
        {file && <span className="hr-import-file">{file.name}</span>}
        <label className="hr-punch-opt"><input type="checkbox" checked={overwrite} disabled={busy || !!done} onChange={(e) => { setOverwrite(e.target.checked); if (file) preview(file, e.target.checked, decisions); }} /> 이미 적힌 날도 세콤 기록으로 덮기</label>
      </div>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {busy && !report && <div className="b2b-loading">읽는 중...</div>}
      {!report && !busy && !error && <div className="b2b-empty">세콤에서 받은 {title} 출근 기록 파일을 고르세요.</div>}

      {report && settings && (
        <>
          {done && (done.failed.length > 0
            ? <div className="b2b-error" role="alert">넣지 못한 직원: {done.failed.join(" / ")}</div>
            : <div className="sm-success">근무 {report.counts.add + report.counts.change}일을 근무대장에 넣었습니다.</div>)}

          <div className="hr-import-counts">
            <span>직원 <strong>{report.counts.people}</strong>명</span>
            <span>자동 <strong>{report.counts.auto}</strong>일</span>
            <span>확인할 줄 <strong>{report.counts.check}</strong>건{!done && open > 0 && <span className="hr-bad"> · 정하지 않은 {open}건</span>}</span>
            <span>그대로 둔 날 <strong>{report.counts.keep}</strong>일</span>
          </div>
          {report.notes.length > 0 && <ul className="hr-import-list hr-rule">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {report.names.length === 0 && <div className="sm-warn">{report.blocked || "이 달에 넣을 줄이 없습니다. 달과 파일을 확인하세요."}</div>}

          {!done && (
            <div className="hr-punch-settings">
              <label>지각·조퇴로 보지 않는 시간 <input className="b2b-input num" inputMode="numeric" value={settings.grace} aria-label="지각·조퇴로 보지 않는 분" onChange={(e) => setSettings({ ...settings, grace: e.target.value.replace(/[^\d]/g, "").slice(0, 2) })} /> 분</label>
              <label>퇴근 뒤 이만큼 넘게 남으면 확인 <input className="b2b-input num" inputMode="numeric" value={settings.over} aria-label="연장을 확인하는 분" onChange={(e) => setSettings({ ...settings, over: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })} /> 분</label>
              {settingsDirty && <button type="button" className="b2b-btn-secondary" onClick={saveSettings} disabled={busy || settings.grace === "" || settings.over === ""}>기준 저장</button>}
            </div>
          )}

          {!done && (
            <section className="hr-sec">
              <div className="hr-sec-head">
                <h2>이름 짝{unmatched > 0 && <span className="b2b-status-pill hr-pill-bad" style={{ marginLeft: 8 }}>정할 이름 {unmatched}명</span>}</h2>
                <div className="hr-punch-actions">
                  <button type="button" className="b2b-btn-secondary" onClick={() => setAllNames((v) => !v)}>{allNames ? "정할 이름만" : `모두 보기 (${report.names.length})`}</button>
                  <button type="button" className="b2b-btn-primary" onClick={saveNames} disabled={busy || !nameDirty}>이름 짝 저장</button>
                </div>
              </div>
              {nameRows.length === 0 ? null : (
                <div className="b2b-table-wrap">
                  <table className="b2b-table hr-table hr-punch-table">
                    <thead><tr><th>세콤의 이름</th><th className="num">줄</th><th className="num">찍힌 날</th><th>직원</th></tr></thead>
                    <tbody>
                      {nameRows.map((n) => {
                        const cur = names[n.source] ?? { employee_id: n.employee_id, skip: n.skip };
                        const value = cur.skip ? SKIP : cur.employee_id || "";
                        return (
                          <tr key={n.source}>
                            <td><strong>{n.source}</strong>{n.state === "auto" && !names[n.source] && <span className="b2b-status-pill hr-pill-off" style={{ marginLeft: 8 }}>같은 이름</span>}</td>
                            <td className="num">{n.days}</td>
                            <td className="num">{n.punched}</td>
                            <td>
                              <select className="b2b-input" value={value} aria-label={`${n.source} 직원`} disabled={busy}
                                onChange={(e) => { const v = e.target.value; setNames((p) => ({ ...p, [n.source]: v === SKIP ? { employee_id: null, skip: true } : { employee_id: v || null, skip: false } })); }}>
                                <option value="">직원 고르기</option>
                                <option value={SKIP}>넣지 않음</option>
                                {report.employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.workplace ? ` · ${e.workplace}` : ""}</option>)}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section className="hr-sec">
            <div className="hr-sec-head"><h2>확인할 줄</h2></div>
            {report.checks.length === 0 ? <div className="b2b-empty">{unmatched > 0 ? "이름 짝을 저장하면 확인할 줄이 나옵니다." : "확인할 줄이 없습니다."}</div> : (
              <div className="b2b-table-wrap">
                <table className="b2b-table hr-table hr-punch-table">
                  <thead><tr><th>직원</th><th>날짜</th><th>찍힌 시각</th><th>확인할 것</th><th>처리</th><th>출근</th><th>퇴근</th><th>휴게(분)</th><th className="num">근무 시간</th></tr></thead>
                  <tbody>
                    {report.checks.map((c) => {
                      const d = decisionOf(c);
                      const timed = d?.action === "work" || d?.action === "holiday_work";
                      const start = d?.start || "", end = d?.end || "";
                      // 휴게를 직접 넣지 않았으면 규칙대로(평소만큼 머문 날 = 평소 휴게, 덜 머문 날 = 법정 최소)
                      const autoBreak = breakFor({ break_min: c.sched.break_min, work_start: c.sched.start, work_end: c.sched.end }, start, end);
                      const brk = d?.break_min ?? autoBreak;
                      const h = timed && isTime(start) && isTime(end) ? hoursFromTimes(start, end, brk) : null;
                      return (
                        <tr key={c.key} className={decisionProblem(d) ? "hr-punch-open" : ""}>
                          <td><strong>{c.name}</strong>{c.workplace && <span className="sm-muted"> {c.workplace}</span>}</td>
                          <td className="sm-nowrap">{dayLabel(c.date)}</td>
                          <td className="sm-nowrap">{c.in || c.out ? `${c.in || "--:--"} ~ ${c.out || "--:--"}` : "없음"}</td>
                          <td>
                            {c.issues.join(" · ")}
                            {c.note && <span className="hr-punch-note">미리 적음: {NOTE_KIND_LABEL[c.note.kind]}{c.note.in_time || c.note.out_time ? ` ${c.note.in_time || "--:--"}~${c.note.out_time || "--:--"}` : ""}{c.note.memo ? ` · ${c.note.memo}` : ""}</span>}
                          </td>
                          <td>
                            <select className="b2b-input hr-w-kind" value={d?.action || ""} aria-label={`${c.name} ${c.date} 처리`} disabled={busy || !!done} onChange={(e) => setAction(c, e.target.value)}>
                              <option value="">고르기</option>
                              {c.actions.map((a) => <option key={a} value={a}>{PUNCH_ACTION_LABEL[a]}</option>)}
                            </select>
                          </td>
                          <td>{timed && <input type="time" className="b2b-input hr-w-time" value={start} aria-label={`${c.name} ${c.date} 출근`} disabled={busy || !!done} onChange={(e) => setDecision(c, { start: e.target.value, break_min: undefined })} />}</td>
                          <td>{timed && <input type="time" className="b2b-input hr-w-time" value={end} aria-label={`${c.name} ${c.date} 퇴근`} disabled={busy || !!done} onChange={(e) => setDecision(c, { end: e.target.value, break_min: undefined })} />}</td>
                          <td>{timed && <input className="b2b-input num hr-w-num" inputMode="numeric" value={String(brk)} aria-label={`${c.name} ${c.date} 휴게`} disabled={busy || !!done}
                            onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, "").slice(0, 3); setDecision(c, { break_min: v === "" ? 0 : Number(v) }); }} />}</td>
                          <td className="num">{h ? hoursText(h.hours) : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
