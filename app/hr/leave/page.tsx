"use client";

// 연차 — 직원마다 한 줄(발생·사용·잔여·곧 소멸). 줄을 누르면 발생 건과 사용 내역이 펼쳐진다.
//  화면을 열 때 오늘까지 생겼어야 할 자동 발생 건이 들어온다(서버, 한 번만). 사용은 근무대장의 연차 줄이다 —
//  [사용 등록]은 근무대장에 그 줄을 넣고, 급여는 그 줄을 유급 시간으로 계산한다.
//  '사용 내역' 탭은 한 달 동안 쓴 연차를 모든 직원에 걸쳐 날짜 순으로 보여 준다(같은 자료 — 서버를 따로 부르지 않는다).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { useEscClose } from "@/app/lib/use-esc";
import { LEAVE_BASIS_LABEL, WEEKDAYS, isActiveOn, isDate, todayKst } from "@/app/lib/hr";
import { isMonth, shiftMonth, weekdayOf } from "@/app/lib/hr-work";
import { GRANT_KIND_LABEL, dayText, leaveBasisOf, partTimeFactor, summarizeLeave, type GrantView, type LeaveEmployee, type LeaveGrant, type LeaveSummary, type LeaveUse, type LeaveWorkplace } from "@/app/lib/hr-leave";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";   // 업무도우미와 같이 쓰는 검색 고르기(화면 부품일 뿐 — 자료에는 닿지 않는다)
import { HrApiError, errText, hrApi } from "../api";

type Data = {
  today: string; workplaces: LeaveWorkplace[]; employees: LeaveEmployee[]; grants: LeaveGrant[]; uses: LeaveUse[];
  compare: Record<string, { hire: number; fiscal: number; short: number }>; added: number;
};
type Tab = "active" | "left" | "uses";
type History = { id: number; at: string; actor: string; action: string; target_name: string; detail: Record<string, unknown> };
const TAB_LABEL: Record<Tab, string> = { active: "재직", left: "퇴사", uses: "사용 내역" };
const STATE_LABEL: Record<GrantView["state"], string> = { valid: "유효", expired: "기간 끝남", future: "시작 전", voided: "없던 것으로 함", minus: "빼는 건" };
const PART_LABEL: Record<string, string> = { "1": "연차", "0.5": "반차", "0.25": "반반차" };
const ACTION_LABEL: Record<string, string> = {
  leave_auto: "자동 발생", leave_grant: "연차 추가", leave_grant_update: "발생 건 수정", leave_grant_delete: "발생 건 삭제", leave_use: "사용 등록", leave_use_cancel: "사용 취소",
};
const kstText = (iso: string) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");

export default function HrLeavePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("active");
  const [wp, setWp] = useState("");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState(() => todayKst().slice(0, 7));   // '사용 내역' 탭이 보는 달
  const [open, setOpen] = useState<string | null>(null);
  const [grantFor, setGrantFor] = useState<{ employee: string } | null>(null);
  const [useFor, setUseFor] = useState<{ employee: string } | null>(null);
  const [editGrant, setEditGrant] = useState<GrantView | null>(null);
  const [history, setHistory] = useState<History[] | null>(null);

  const [added, setAdded] = useState(0);                 // 이번에 화면을 열며 들어온 자동 발생 건 수

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const j = await hrApi<Data>("/api/hr/leave");
      setD(j);
      if (!quiet) setAdded(j.added || 0);
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "연차를 불러오지 못했습니다."));
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const wpOf = useMemo(() => new Map((d?.workplaces || []).map((w) => [w.id, w])), [d]);
  const sumOf = useMemo(() => {
    const m = new Map<string, LeaveSummary>();
    if (!d) return m;
    const g = new Map<string, LeaveGrant[]>(), u = new Map<string, LeaveUse[]>();
    for (const x of d.grants) { if (!g.has(x.employee_id)) g.set(x.employee_id, []); g.get(x.employee_id)!.push(x); }
    for (const x of d.uses) { if (!u.has(x.employee_id)) u.set(x.employee_id, []); u.get(x.employee_id)!.push(x); }
    for (const e of d.employees) m.set(e.id, summarizeLeave(g.get(e.id) || [], u.get(e.id) || [], d.today));
    return m;
  }, [d]);
  const usesOf = useCallback((id: string) => (d?.uses || []).filter((x) => x.employee_id === id).sort((a, b) => b.work_date.localeCompare(a.work_date)), [d]);

  const rows = useMemo(() => {
    if (!d) return [];
    const k = q.trim().toLowerCase();
    return d.employees.filter((e) => {
      const active = isActiveOn(e, d.today);
      if (tab === "active" ? !active : active) return false;
      if (wp && e.workplace_id !== wp) return false;
      return !k || [e.name, e.emp_no, e.dept, e.position].some((v) => v.toLowerCase().includes(k));
    });
  }, [d, tab, wp, q]);
  // 사용 내역(그 달) — 날짜 순. 사업장·검색으로 좁힌다
  const empOf = useMemo(() => new Map((d?.employees || []).map((e) => [e.id, e])), [d]);
  const monthUses = useMemo(() => (d?.uses || []).filter((u) => u.work_date.slice(0, 7) === month && empOf.has(u.employee_id)), [d, month, empOf]);
  const useRows = useMemo(() => {
    const k = q.trim().toLowerCase();
    return monthUses.map((u) => ({ u, e: empOf.get(u.employee_id)! }))
      .filter(({ e }) => (!wp || e.workplace_id === wp) && (!k || [e.name, e.emp_no, e.dept, e.position].some((v) => v.toLowerCase().includes(k))))
      .sort((a, b) => a.u.work_date.localeCompare(b.u.work_date) || a.e.name.localeCompare(b.e.name, "ko"));
  }, [monthUses, empOf, wp, q]);
  const useDays = useMemo(() => useRows.reduce((s, r) => s + r.u.days, 0), [useRows]);

  const counts = useMemo(() => {
    const c = { active: 0, left: 0, uses: monthUses.length };
    for (const e of d?.employees || []) c[isActiveOn(e, d!.today) ? "active" : "left"]++;
    return c;
  }, [d, monthUses]);
  const multiWp = (d?.workplaces.length || 0) > 1;

  async function cancelUse(e: LeaveEmployee, u: LeaveUse) {
    const ok = await confirm({ title: `${u.work_date} ${PART_LABEL[String(u.days)] || `${u.days}일`} 사용 취소`, body: u.kind === "leave" ? "근무대장에서 그 날의 연차 줄을 지웁니다." : "근무대장에서 그 날의 반차·반반차 표시를 지웁니다(근무 기록은 그대로).", action: "사용 취소" });
    if (!ok) return;
    try {
      await hrApi("/api/hr/leave", "POST", { action: "cancel_use", employee_id: e.id, date: u.work_date });
      setD((p) => (p ? { ...p, uses: p.uses.filter((x) => !(x.employee_id === e.id && x.work_date === u.work_date)) } : p));
      toast.success("사용을 취소했습니다");
    } catch (err) { toast.error(errText(err, "사용을 취소하지 못했습니다.")); }
  }
  async function removeGrant(g: GrantView) {
    const ok = await confirm({ title: `${g.grant_date} ${dayText(g.days)}일 삭제`, body: "직접 추가한 발생 건을 지웁니다.", action: "발생 건 삭제" });
    if (!ok) return;
    try {
      await hrApi(`/api/hr/leave?id=${g.id}`, "DELETE");
      setD((p) => (p ? { ...p, grants: p.grants.filter((x) => x.id !== g.id) } : p));
      toast.success("발생 건을 삭제했습니다");
    } catch (err) { toast.error(errText(err, "발생 건을 지우지 못했습니다.")); }
  }
  async function showHistory() {
    if (history) { setHistory(null); return; }
    try { setHistory((await hrApi<{ history: History[] }>("/api/hr/leave?history=1")).history); }
    catch (err) { toast.error(errText(err, "이력을 불러오지 못했습니다.")); }
  }

  const cols = 9 + (multiWp ? 1 : 0);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">연차</h1></div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={showHistory} disabled={loading || !!error}>{history ? "이력 닫기" : "이력 보기"}</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setGrantFor({ employee: "" })} disabled={loading || !d || d.employees.length === 0}>연차 추가</button>
          <button type="button" className="b2b-btn-primary" onClick={() => setUseFor({ employee: "" })} disabled={loading || !d || d.employees.length === 0}>사용 등록</button>
        </div>
      </header>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {!loading && !error && added > 0 && <div className="sm-success">오늘까지 생긴 연차 {added}건을 넣었습니다.</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error || !d ? null : d.employees.length === 0 ? (
        <div className="b2b-empty">등록된 직원이 없습니다.</div>
      ) : (
        <>
          <div className="hr-filters">
            <div className="sm-tabs">
              {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
                <button key={t} type="button" className={`sm-tab ${tab === t ? "is-active" : ""}`} onClick={() => setTab(t)}>{TAB_LABEL[t]}<span className="sm-tab-count">{counts[t]}</span></button>
              ))}
            </div>
            {multiWp && (
              <select className="b2b-input" value={wp} onChange={(e) => setWp(e.target.value)} aria-label="사업장">
                <option value="">모든 사업장</option>
                {d.workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            )}
            {tab === "uses" && (
              <>
                <button type="button" className="b2b-btn-secondary" onClick={() => setMonth(shiftMonth(month, -1))}>이전 달</button>
                <input type="month" className="b2b-input hr-month" value={month} aria-label="달" onChange={(e) => { if (isMonth(e.target.value)) setMonth(e.target.value); }} />
                <button type="button" className="b2b-btn-secondary" onClick={() => setMonth(shiftMonth(month, 1))}>다음 달</button>
              </>
            )}
            <input className="b2b-input hr-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색" aria-label="성명·사번·부서 검색" />
          </div>
          {tab !== "uses" && <p className="hr-rule">일 단위. 발생·사용·잔여는 지금 쓸 수 있는 발생 건 기준이고, 곧 소멸은 60일 안에 끝나는 건의 남은 일수입니다.</p>}

          {tab === "uses" ? (
            useRows.length === 0 ? (
              <div className="b2b-empty">{monthUses.length > 0 ? "조건에 맞는 사용 내역이 없습니다." : `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월에 쓴 연차가 없습니다.`}</div>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table hr-table">
                  <thead>
                    <tr>
                      <th>날짜</th><th>요일</th>{multiWp && <th>사업장</th>}<th>사번</th><th>성명</th><th>부서</th><th>종류</th><th className="num">일수</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {useRows.map(({ u, e }) => (
                      <tr key={`${u.employee_id}|${u.work_date}`}>
                        <td>{u.work_date}</td>
                        <td>{WEEKDAYS[weekdayOf(u.work_date) - 1]}</td>
                        {multiWp && <td>{wpOf.get(e.workplace_id)?.name || ""}</td>}
                        <td className="hr-mono">{e.emp_no}</td>
                        <td><strong>{e.name}</strong></td>
                        <td>{e.dept}</td>
                        <td>{PART_LABEL[String(u.days)] || ""}{u.kind === "work" ? " (근무한 날)" : ""}</td>
                        <td className="num">{dayText(u.days)}</td>
                        <td className="actions"><button type="button" className="b2b-link-btn" onClick={() => cancelUse(e, u)}>사용 취소</button></td>
                      </tr>
                    ))}
                    <tr className="hr-pay-sum">
                      <td colSpan={multiWp ? 7 : 6}>합계 {useRows.length}건</td>
                      <td className="num">{dayText(useDays)}</td><td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          ) : rows.length === 0 ? (
            <div className="b2b-empty">{q.trim() || wp ? "조건에 맞는 직원이 없습니다." : tab === "left" ? "최근 1년 안에 퇴사한 직원이 없습니다." : "재직 중인 직원이 없습니다."}</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table is-clickable hr-table">
                <thead>
                  <tr>
                    {multiWp && <th>사업장</th>}
                    <th>사번</th><th>성명</th><th>입사일</th><th>기준</th><th className="num">발생</th><th className="num">사용</th><th className="num">잔여</th><th className="num">곧 소멸</th><th>확인할 것</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => {
                    const s = sumOf.get(e.id);
                    const w = wpOf.get(e.workplace_id);
                    const cmp = d.compare[e.id];
                    const auto = !!w?.five_plus && partTimeFactor(e) > 0;
                    const notes = [
                      s && s.over > 0 ? `발생 건 없이 쓴 ${dayText(s.over)}일` : "",
                      s && s.left < 0 ? "잔여가 0보다 적음" : "",
                      cmp && cmp.short > 0 ? `퇴사 정산: 입사일 기준보다 ${dayText(cmp.short)}일 적음` : "",
                    ].filter(Boolean);
                    return (
                      <Fragment key={e.id}>
                        <tr onClick={() => setOpen(open === e.id ? null : e.id)} tabIndex={0} role="button" aria-expanded={open === e.id}
                          onKeyDown={(ev) => { if (ev.key === "Enter") setOpen(open === e.id ? null : e.id); }}>
                          {multiWp && <td>{w?.name || ""}</td>}
                          <td className="hr-mono">{e.emp_no}</td>
                          <td><strong>{e.name}</strong></td>
                          <td>{e.hire_date}{e.leave_date ? ` ~ ${e.leave_date}` : ""}</td>
                          <td>{auto && w ? LEAVE_BASIS_LABEL[leaveBasisOf(e, w)] : !w?.five_plus ? "5인 미만 — 자동 발생 없음" : "주 15시간 미만 — 자동 발생 없음"}</td>
                          <td className="num">{dayText(s?.granted)}</td>
                          <td className="num">{dayText(s?.used)}</td>
                          <td className="num"><strong>{dayText(s?.left)}</strong></td>
                          <td className="num">{s && s.expiring > 0 ? <span className="b2b-status-pill hr-pill-off">{dayText(s.expiring)}일</span> : 0}</td>
                          <td>{notes.length > 0 ? <span className="hr-bad">{notes.join(" · ")}</span> : ""}</td>
                        </tr>
                        {open === e.id && s && (
                          <tr className="hr-leave-detail">
                            <td colSpan={cols}>
                              <div className="hr-leave-box">
                                <div className="hr-sec-head">
                                  <h2>발생 건</h2>
                                  <div className="b2b-page-actions">
                                    <button type="button" className="b2b-btn-secondary" onClick={() => setGrantFor({ employee: e.id })}>연차 추가</button>
                                    <button type="button" className="b2b-btn-secondary" onClick={() => setUseFor({ employee: e.id })}>사용 등록</button>
                                  </div>
                                </div>
                                {cmp && <p className="hr-rule">퇴사 정산 비교 — 재직 기간 전체 발생: 입사일 기준 {dayText(cmp.hire)}일, 회계연도 기준 {dayText(cmp.fiscal)}일.</p>}
                                {s.grants.length === 0 ? <p className="hr-rule">발생 건이 없습니다.</p> : (
                                  <div className="b2b-table-wrap">
                                    <table className="b2b-table hr-table">
                                      <thead><tr><th>발생일</th><th>만료일</th><th className="num">일수</th><th className="num">사용</th><th className="num">남음</th><th>종류</th><th>상태</th><th>사유</th><th>넣은 사람</th><th></th></tr></thead>
                                      <tbody>
                                        {s.grants.map((g) => (
                                          <tr key={g.id} className={g.state === "valid" ? "" : "hr-leave-dim"}>
                                            <td>{g.grant_date}</td><td>{g.expire_date || "기한 없음"}</td>
                                            <td className="num">{dayText(g.days)}</td><td className="num">{g.days > 0 ? dayText(g.used) : ""}</td><td className="num">{g.days > 0 && !g.voided ? dayText(g.left) : ""}</td>
                                            <td>{GRANT_KIND_LABEL[g.kind]}</td>
                                            <td><span className={`b2b-status-pill ${g.state === "valid" ? "hr-pill-ok" : "hr-pill-off"}`}>{STATE_LABEL[g.state]}</span></td>
                                            <td style={{ whiteSpace: "normal", minWidth: 180 }}>{g.reason}</td>
                                            <td>{g.created_by}</td>
                                            <td className="actions">
                                              <button type="button" className="b2b-link-btn" onClick={() => setEditGrant(g)}>발생 건 수정</button>
                                              {g.kind === "manual" && <button type="button" className="b2b-link-btn" onClick={() => removeGrant(g)}>발생 건 삭제</button>}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                                <div className="hr-sec-head" style={{ marginTop: 16 }}><h2>사용 내역</h2></div>
                                {usesOf(e.id).length === 0 ? <p className="hr-rule">사용 내역이 없습니다.</p> : (
                                  <div className="b2b-table-wrap">
                                    <table className="b2b-table hr-table">
                                      <thead><tr><th>날짜</th><th>종류</th><th className="num">일수</th><th></th></tr></thead>
                                      <tbody>
                                        {usesOf(e.id).slice(0, 60).map((u) => (
                                          <tr key={u.work_date}>
                                            <td>{u.work_date}</td><td>{PART_LABEL[String(u.days)] || ""}{u.kind === "work" ? " (근무한 날)" : ""}</td><td className="num">{dayText(u.days)}</td>
                                            <td className="actions"><button type="button" className="b2b-link-btn" onClick={() => cancelUse(e, u)}>사용 취소</button></td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {history && (
            <section className="hr-sec">
              <div className="hr-sec-head"><h2>이력</h2></div>
              {history.length === 0 ? <div className="b2b-empty">이력이 없습니다.</div> : (
                <div className="b2b-table-wrap">
                  <table className="b2b-table hr-table">
                    <thead><tr><th>때</th><th>누가</th><th>무엇을</th><th>대상</th><th>내용</th></tr></thead>
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.id}>
                          <td>{kstText(h.at)}</td><td>{h.actor}</td><td>{ACTION_LABEL[h.action] || h.action}</td><td>{h.target_name}</td>
                          <td style={{ whiteSpace: "normal", minWidth: 260 }} className="hr-pay-calc">{historyText(h.detail)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {grantFor && d && (
        <GrantForm employees={d.employees} today={d.today} employee={grantFor.employee} onClose={() => setGrantFor(null)}
          onSaved={(g) => { setGrantFor(null); setD((p) => (p ? { ...p, grants: [...p.grants, g] } : p)); setOpen(g.employee_id); toast.success(g.days > 0 ? `연차 ${dayText(g.days)}일을 추가했습니다` : `연차 ${dayText(-g.days)}일을 뺐습니다`); }} />
      )}
      {useFor && d && (
        <UseForm employees={d.employees} today={d.today} employee={useFor.employee} onClose={() => setUseFor(null)}
          onSaved={(id, done, skipped) => {
            setUseFor(null); setOpen(id); load(true);
            if (skipped.length > 0) toast.error(`${done}일 등록, ${skipped.length}일은 넣지 못했습니다 — ${skipped[0].date} ${skipped[0].reason}`);
            else toast.success(`${done}일의 연차 사용을 등록했습니다`);
          }} />
      )}
      {editGrant && (
        <GrantEdit grant={editGrant} onClose={() => setEditGrant(null)}
          onSaved={(g) => { setEditGrant(null); setD((p) => (p ? { ...p, grants: p.grants.map((x) => (x.id === g.id ? g : x)) } : p)); toast.success("발생 건을 저장했습니다"); }} />
      )}
    </div>
  );
}

function historyText(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const d = detail || {};
  if (d.count != null) parts.push(`${d.count}건`);
  if (d.days != null) parts.push(`${d.days}일`);
  if (d.grant_date) parts.push(`발생일 ${d.grant_date}`);
  if (d.expire_date) parts.push(`만료일 ${d.expire_date}`);
  if (d.from) parts.push(`${d.from}${d.to && d.to !== d.from ? ` ~ ${d.to}` : ""}`);
  if (d.date) parts.push(String(d.date));
  if (d.reason) parts.push(String(d.reason));
  const ch = d.changed as Record<string, unknown> | undefined;
  if (ch) parts.push(Object.entries(ch).map(([k, v]) => `${({ days: "일수", expire_date: "만료일", reason: "사유", voided: "없던 것으로" } as Record<string, string>)[k] || k} → ${v === true ? "예" : v === false ? "아니오" : v ?? "없음"}`).join(", "));
  return parts.join(" · ");
}

// 직원 고르기 — 이름·생년월일·사번·부서를 쳐서 찾는다(초성도 된다: "ㄱㅅㅎ"). 같은 이름은 아래 줄의 생년월일로 가린다.
//  생년월일은 1990-01-01 · 19900101 · 900101 어느 모양으로 쳐도 찾힌다.
const employeeLabel = (e: LeaveEmployee) => `${e.name}${e.emp_no ? ` (${e.emp_no})` : ""}${e.leave_date ? " · 퇴사" : ""}`;
function EmployeePicker({ employees, value, onChange, invalid }: { employees: LeaveEmployee[]; value: string; onChange: (id: string) => void; invalid?: boolean }) {
  const options: ComboOption[] = useMemo(() => employees.map((e) => {
    const b = e.birth_date || "";
    return {
      id: e.id, label: employeeLabel(e),
      sub: [b, e.dept, e.position].filter(Boolean).join(" · "),
      extra: b ? `${b.replace(/-/g, "")} ${b.replace(/-/g, "").slice(2)}` : "",
    };
  }), [employees]);
  const picked = employees.find((e) => e.id === value);
  return (
    <Combobox value={picked ? employeeLabel(picked) : ""} options={options} onSelect={(o) => onChange(o.id)}
      placeholder="이름·생년월일·사번으로 찾기" emptyText="일치하는 직원이 없습니다" ariaLabel="직원" invalid={invalid} />
  );
}

// 연차 추가 — 포상·이월·차감·도입 시점 잔여 맞추기. 일수가 음수면 빼는 건이다.
function GrantForm({ employees, today, employee, onClose, onSaved }: { employees: LeaveEmployee[]; today: string; employee: string; onClose: () => void; onSaved: (g: LeaveGrant) => void }) {
  const [f, setF] = useState({ employee_id: employee, days: "", grant_date: today, expire_date: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);
  const set = <K extends keyof typeof f>(k: K, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true); setFormError(""); setErrors({});
    try {
      const j = await hrApi<{ grant: LeaveGrant }>("/api/hr/leave", "POST", { action: "grant", ...f, days: Number(f.days) });
      onSaved(j.grant);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("연차를 추가하지 못했습니다.");
      setBusy(false);
    }
  }
  const err = (k: string) => (errors[k] ? <span className="b2b-field-error">{errors[k]}</span> : null);
  const inv = (k: string) => (errors[k] ? ("true" as const) : undefined);

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label="연차 추가">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">연차 추가</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <div className="b2b-field hr-span2">
                <span className="b2b-field-label">직원<span className="req">*</span></span>
                <EmployeePicker employees={employees} value={f.employee_id} onChange={(id) => set("employee_id", id)} invalid={!!errors.employee_id} />
                {err("employee_id")}
              </div>
              <label className="b2b-field">
                <span className="b2b-field-label">일수<span className="req">*</span><span className="opt"> 빼려면 음수</span></span>
                <input className="b2b-input num" inputMode="decimal" value={f.days} placeholder="0" onChange={(e) => set("days", e.target.value.replace(/[^\d.-]/g, ""))} aria-invalid={inv("days")} />
                {err("days")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">발생일<span className="req">*</span></span>
                <input className="b2b-input" type="date" value={f.grant_date} onChange={(e) => set("grant_date", e.target.value)} aria-invalid={inv("grant_date")} />
                {err("grant_date")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">만료일<span className="opt"> 비우면 기한 없음</span></span>
                <input className="b2b-input" type="date" value={f.expire_date} onChange={(e) => set("expire_date", e.target.value)} aria-invalid={inv("expire_date")} />
                {err("expire_date")}
              </label>
              <label className="b2b-field hr-wide">
                <span className="b2b-field-label">사유<span className="req">*</span></span>
                <input className="b2b-input" value={f.reason} maxLength={200} onChange={(e) => set("reason", e.target.value)} aria-invalid={inv("reason")} />
                {err("reason")}
              </label>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : "연차 추가"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 사용 등록 — 기간의 소정근로일마다 근무대장에 연차 줄을 넣는다
function UseForm({ employees, today, employee, onClose, onSaved }: {
  employees: LeaveEmployee[]; today: string; employee: string; onClose: () => void;
  onSaved: (employeeId: string, done: number, skipped: { date: string; reason: string }[]) => void;
}) {
  const [f, setF] = useState({ employee_id: employee, from: today, to: today, part: "1" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);
  const set = <K extends keyof typeof f>(k: K, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true); setFormError(""); setErrors({});
    try {
      const j = await hrApi<{ done: string[]; skipped: { date: string; reason: string }[] }>("/api/hr/leave", "POST", { action: "use", employee_id: f.employee_id, from: f.from, to: f.to || f.from, part: Number(f.part) });
      onSaved(f.employee_id, j.done.length, j.skipped);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("사용을 등록하지 못했습니다.");
      setBusy(false);
    }
  }
  const err = (k: string) => (errors[k] ? <span className="b2b-field-error">{errors[k]}</span> : null);
  const inv = (k: string) => (errors[k] ? ("true" as const) : undefined);

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label="사용 등록">
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">사용 등록</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <div className="b2b-field hr-wide">
                <span className="b2b-field-label">직원<span className="req">*</span></span>
                <EmployeePicker employees={employees} value={f.employee_id} onChange={(id) => set("employee_id", id)} invalid={!!errors.employee_id} />
                {err("employee_id")}
              </div>
              <label className="b2b-field">
                <span className="b2b-field-label">시작일<span className="req">*</span></span>
                <input className="b2b-input" type="date" value={f.from} onChange={(e) => { const v = e.target.value; setF((p) => ({ ...p, from: v, to: isDate(v) && (!isDate(p.to) || p.to < v) ? v : p.to })); }} aria-invalid={inv("from")} />
                {err("from")}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">종료일<span className="req">*</span></span>
                <input className="b2b-input" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} aria-invalid={inv("to")} />
                {err("to")}
              </label>
              <div className="b2b-field">
                <span className="b2b-field-label">종류</span>
                <div className="sm-tabs">
                  {(["1", "0.5", "0.25"] as const).map((p) => (
                    <button key={p} type="button" className={`sm-tab ${f.part === p ? "is-active" : ""}`} onClick={() => set("part", p)}>{PART_LABEL[p]}</button>
                  ))}
                </div>
                {err("part")}
              </div>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "등록 중..." : "사용 등록"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 발생 건 수정 — 일수·만료일·사유, 없던 것으로 하기(자동 발생 건은 지우지 않고 이렇게 한다)
function GrantEdit({ grant, onClose, onSaved }: { grant: GrantView; onClose: () => void; onSaved: (g: LeaveGrant) => void }) {
  const [f, setF] = useState({ days: String(grant.days), expire_date: grant.expire_date || "", reason: grant.reason, voided: grant.voided });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscClose(onClose, busy);

  async function save() {
    setBusy(true); setFormError(""); setErrors({});
    try {
      const j = await hrApi<{ grant: LeaveGrant }>("/api/hr/leave", "PATCH", { id: grant.id, days: Number(f.days), expire_date: f.expire_date, reason: f.reason, voided: f.voided });
      onSaved(j.grant);
    } catch (e) {
      if (e instanceof HrApiError) { setErrors(e.fields); setFormError(e.message); } else setFormError("발생 건을 저장하지 못했습니다.");
      setBusy(false);
    }
  }
  const title = `${grant.grant_date} ${GRANT_KIND_LABEL[grant.kind]} 수정`;

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal hr-modal-mid" role="dialog" aria-modal="true" aria-label={title}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{title}</span>
          <button type="button" className="b2b-modal-close" onClick={onClose} aria-label="닫기" disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {formError && <div className="b2b-error" role="alert">{formError}</div>}
          <div className="hr-form">
            <section className="hr-form-sec">
              <label className="b2b-field">
                <span className="b2b-field-label">일수</span>
                <input className="b2b-input num" inputMode="decimal" value={f.days} onChange={(e) => setF((p) => ({ ...p, days: e.target.value.replace(/[^\d.-]/g, "") }))} aria-invalid={errors.days ? "true" : undefined} />
                {errors.days && <span className="b2b-field-error">{errors.days}</span>}
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">만료일<span className="opt"> 비우면 기한 없음</span></span>
                <input className="b2b-input" type="date" value={f.expire_date} onChange={(e) => setF((p) => ({ ...p, expire_date: e.target.value }))} aria-invalid={errors.expire_date ? "true" : undefined} />
                {errors.expire_date && <span className="b2b-field-error">{errors.expire_date}</span>}
              </label>
              <div className="b2b-field">
                <span className="b2b-field-label">상태</span>
                <div className="hr-checks">
                  <label><input type="checkbox" className="b2b-checkbox" checked={f.voided} onChange={(e) => setF((p) => ({ ...p, voided: e.target.checked }))} />없던 것으로</label>
                </div>
              </div>
              <label className="b2b-field hr-wide">
                <span className="b2b-field-label">사유</span>
                <input className="b2b-input" value={f.reason} maxLength={200} onChange={(e) => setF((p) => ({ ...p, reason: e.target.value }))} />
              </label>
            </section>
          </div>
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button type="button" className="b2b-btn-primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : "변경 저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
