"use client";

// 직원 확인 링크 — 직원이 본인의 급여명세서·연차·근태를 본다(보기만). 휴대폰에서 여는 화면이라 한 줄로 쌓는다.
//  처음에는 주민등록번호로 본인 확인을 하고, 통과하면 그 기기에서 30일 동안 다시 묻지 않는다.
//  자료는 /api/me/<토큰> 이 주소의 토큰과 확인 상태를 검증한 뒤에만 준다.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { numText, WEEKDAYS } from "@/app/lib/hr";
import { WORK_KIND_LABEL, hoursText, shiftMonth, weekdayOf } from "@/app/lib/hr-work";
import { dayText } from "@/app/lib/hr-leave";
import type { MeBundle, MeResponse } from "@/app/lib/hr-me-types";

const TITLE = "급여·연차 확인";
type Tab = "pay" | "leave" | "work";
const TAB_LABEL: Record<Tab, string> = { pay: "급여명세서", leave: "연차", work: "근태" };
const monthKo = (m: string) => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5))}월`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const won = (n: number) => `${numText(n)}원`;
const hrs = (n: number) => `${hoursText(n)}시간`;

async function call<T>(url: string, method = "GET", body?: unknown): Promise<{ status: number; json: T & { ok?: boolean; error?: string; locked?: boolean } }> {
  const res = await fetch(url, {
    method, cache: "no-store", credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string; locked?: boolean };
  return { status: res.status, json };
}

export default function MePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const api = `/api/me/${encodeURIComponent(token)}`;
  const [d, setD] = useState<MeResponse | null>(null);
  const [gone, setGone] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("pay");

  const load = useCallback(async (month?: string) => {
    try {
      const r = await call<MeResponse>(`${api}${month ? `?month=${month}` : ""}`);
      if (r.status === 200 && r.json.ok) { setD(r.json); setGone(""); }
      else setGone(r.json.error || "지금은 볼 수 없습니다. 잠시 뒤 다시 열어 주세요.");
    } catch { setGone("연결하지 못했습니다. 잠시 뒤 다시 열어 주세요."); }
    setLoading(false);
  }, [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (document.title !== TITLE) document.title = TITLE; });

  async function leave() {
    await call(api, "DELETE").catch(() => {});
    setD(null); setLoading(true); load();
  }

  if (loading) return <main className="me-page"><p className="me-note">불러오는 중...</p></main>;
  if (gone || !d) return <main className="me-page"><h1 className="me-title">{TITLE}</h1><div className="b2b-error" role="alert">{gone || "지금은 볼 수 없습니다."}</div></main>;
  if (d.need === "verify") return <Verify api={api} locked={d.locked} blocked={d.blocked} canVerify={d.can_verify} onDone={() => { setLoading(true); load(); }} />;

  return (
    <main className="me-page">
      <header className="me-head">
        <div>
          <div className="me-co">{d.me.workplace}</div>
          <h1 className="me-title">{d.me.name} 님</h1>
          <div className="me-sub">{[d.me.dept, d.me.position].filter(Boolean).join(" ")}</div>
        </div>
        <button type="button" className="b2b-btn-secondary" onClick={leave}>나가기</button>
      </header>
      <div className="sm-tabs me-tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => <button key={t} type="button" className={`sm-tab ${tab === t ? "is-active" : ""}`} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
      </div>
      {tab === "pay" && <Pay d={d} />}
      {tab === "leave" && <Leave d={d} />}
      {tab === "work" && <Work d={d} onMonth={(m) => load(m)} />}
    </main>
  );
}

// 본인 확인 — 주민등록번호 앞 6자리와 뒤 7자리. 입력한 번호는 확인에만 쓰고 저장하지 않는다.
function Verify({ api, locked, blocked, canVerify, onDone }: { api: string; locked: boolean; blocked: boolean; canVerify: boolean; onDone: () => void }) {
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [error, setError] = useState(blocked ? "여러 번 틀려 잠긴 링크입니다. 담당자에게 새 링크를 받으세요." : locked ? "여러 번 틀려 잠겼습니다. 15분 뒤에 다시 입력하세요." : "");
  const [isLocked, setIsLocked] = useState(locked || blocked);
  const [busy, setBusy] = useState(false);
  const backRef = useRef<HTMLInputElement>(null);

  // 앞 6자리를 다 넣으면 뒤 칸으로 넘어간다. 13자리를 한꺼번에 붙여넣으면 앞·뒤로 나눠 넣는다.
  function onFront(v: string) {
    const digits = v.replace(/\D/g, "");
    setFront(digits.slice(0, 6));
    if (digits.length > 6) setBack(digits.slice(6, 13));
    if (digits.length >= 6) backRef.current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (front.length !== 6 || back.length !== 7) { setError("주민등록번호 13자리를 모두 입력하세요."); return; }
    setBusy(true); setError("");
    try {
      const r = await call(api, "POST", { rrn: front + back });
      if (r.status === 200 && r.json.ok) { onDone(); return; }
      setError(r.json.error || "확인하지 못했습니다.");
      setIsLocked(!!r.json.locked);
      setBack("");
    } catch { setError("연결하지 못했습니다. 잠시 뒤 다시 시도하세요."); }
    setBusy(false);
  }

  return (
    <main className="me-page">
      <h1 className="me-title">{TITLE}</h1>
      {!canVerify ? (
        <div className="b2b-error" role="alert">본인 확인에 쓸 정보가 등록돼 있지 않습니다. 담당자에게 문의하세요.</div>
      ) : (
        <form className="me-card me-verify" onSubmit={submit}>
          <p className="me-note">본인 확인을 위해 주민등록번호를 입력하세요. 입력한 번호는 확인에만 쓰고 저장하지 않습니다.</p>
          <div className="me-rrn">
            <input className="b2b-input" inputMode="numeric" autoComplete="off" aria-label="주민등록번호 앞 6자리" placeholder="앞 6자리" value={front}
              disabled={busy || isLocked} onChange={(e) => onFront(e.target.value)} />
            <span aria-hidden="true">-</span>
            <input ref={backRef} className="b2b-input" type="password" inputMode="numeric" autoComplete="off" aria-label="주민등록번호 뒤 7자리" placeholder="뒤 7자리" maxLength={7} value={back}
              disabled={busy || isLocked} onChange={(e) => setBack(e.target.value.replace(/\D/g, "").slice(0, 7))} />
          </div>
          {error && <div className="b2b-error" role="alert">{error}</div>}
          <button type="submit" className="b2b-btn-primary" disabled={busy || isLocked}>{busy ? "확인 중..." : "확인"}</button>
        </form>
      )}
    </main>
  );
}

function Pay({ d }: { d: MeBundle }) {
  const [month, setMonth] = useState(d.payslips[0]?.month || "");
  const slip = d.payslips.find((p) => p.month === month) || d.payslips[0];
  if (!slip) return <div className="b2b-empty">확정된 급여명세서가 없습니다.</div>;
  const r = slip.result;
  const rows = (kind: "pay" | "deduct") => r.items.filter((i) => i.kind === kind && (i.amount !== 0 || i.edited));
  return (
    <>
      <select className="b2b-input me-pick" value={slip.month} onChange={(e) => setMonth(e.target.value)} aria-label="귀속월">
        {d.payslips.map((p) => <option key={p.month} value={p.month}>{monthKo(p.month)}</option>)}
      </select>
      <section className="me-card">
        <div className="me-net"><span>실수령액</span><strong>{won(r.net_pay)}</strong></div>
        <div className="me-sub">지급일 {slip.pay_date}</div>
      </section>
      <section className="me-card">
        <h2>지급</h2>
        <ul className="me-list">
          {rows("pay").map((i) => <li key={i.code}><div><span>{i.name}</span>{i.calc && <small>{i.calc}</small>}</div><b>{won(i.amount)}</b></li>)}
          <li className="is-sum"><div><span>지급 합계</span>{r.exempt_total > 0 && <small>비과세 {won(r.exempt_total)} · 과세 {won(r.taxable_total)}</small>}</div><b>{won(r.pay_total)}</b></li>
        </ul>
      </section>
      <section className="me-card">
        <h2>공제</h2>
        <ul className="me-list">
          {rows("deduct").map((i) => <li key={i.code}><div><span>{i.name}</span>{i.calc && <small>{i.calc}</small>}</div><b>{won(i.amount)}</b></li>)}
          <li className="is-sum"><div><span>공제 합계</span></div><b>{won(r.deduct_total)}</b></li>
        </ul>
      </section>
      {r.basis.pay_type === "hourly" && (
        <section className="me-card">
          <h2>근무</h2>
          <div className="me-tiles">
            {([["근무 일수", `${r.basis.workDays}일`], ["근무 시간", hrs(r.basis.worked)], ["연장", hrs(r.basis.overtime)], ["야간", hrs(r.basis.night)], ["휴일 근무", hrs(r.basis.holiday)], ["주휴", hrs(r.basis.weeklyHours)]] as const)
              .map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
          </div>
        </section>
      )}
    </>
  );
}

function Leave({ d }: { d: MeBundle }) {
  const l = d.leave;
  if (!l) return <div className="b2b-empty">연차 정보가 없습니다.</div>;
  return (
    <>
      <section className="me-card">
        <div className="me-net"><span>남은 연차</span><strong>{dayText(l.left)}일</strong></div>
        <div className="me-tiles">
          {([["발생", `${dayText(l.granted)}일`], ["사용", `${dayText(l.used)}일`], ["60일 안 소멸", `${dayText(l.expiring)}일`]] as const).map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
        </div>
      </section>
      <section className="me-card">
        <h2>발생</h2>
        {l.grants.length === 0 ? <p className="me-note">지금 쓸 수 있는 연차가 없습니다.</p> : (
          <ul className="me-list">
            {l.grants.map((g) => (
              <li key={g.id}><div><span>{g.grant_date} ~ {g.expire_date || "기한 없음"}</span><small>{g.reason}{g.state === "future" ? " · 시작 전" : ""}</small></div><b>{dayText(g.left)} / {dayText(g.days)}일</b></li>
            ))}
          </ul>
        )}
      </section>
      <section className="me-card">
        <h2>사용 내역</h2>
        {l.uses.length === 0 ? <p className="me-note">사용 내역이 없습니다.</p> : (
          <ul className="me-list">
            {l.uses.map((u) => <li key={u.work_date}><div><span>{u.work_date} ({WEEKDAYS[weekdayOf(u.work_date) - 1]})</span></div><b>{dayText(u.days)}일</b></li>)}
          </ul>
        )}
      </section>
    </>
  );
}

function Work({ d, onMonth }: { d: MeBundle; onMonth: (m: string) => void }) {
  const a = d.attendance;
  const nowMonth = d.today.slice(0, 7), firstMonth = d.me.hire_date.slice(0, 7);
  const tiles = useMemo(() => ([["근무 일수", `${a.workDays}일`], ["근무 시간", hrs(a.worked)], ["연장", hrs(a.overtime)], ["야간", hrs(a.night)], ["휴일 근무", hrs(a.holiday)], ["결근", `${a.absentDays}일`]] as const), [a]);
  return (
    <>
      <div className="me-month">
        <button type="button" className="b2b-btn-secondary" disabled={a.month <= firstMonth} onClick={() => onMonth(shiftMonth(a.month, -1))}>이전 달</button>
        <strong>{monthKo(a.month)}</strong>
        <button type="button" className="b2b-btn-secondary" disabled={a.month >= nowMonth} onClick={() => onMonth(shiftMonth(a.month, 1))}>다음 달</button>
      </div>
      <section className="me-card">
        <div className="me-tiles">{tiles.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
      </section>
      <section className="me-card">
        <h2>날짜별</h2>
        {a.logs.length === 0 ? <p className="me-note">이 달의 기록이 없습니다.</p> : (
          <ul className="me-list">
            {a.logs.map((x) => (
              <li key={x.work_date}>
                <div>
                  <span>{md(x.work_date)} ({WEEKDAYS[weekdayOf(x.work_date) - 1]}) · {WORK_KIND_LABEL[x.kind]}{x.leave_days > 0 && x.kind === "work" ? ` · ${x.leave_days === 0.5 ? "반차" : x.leave_days === 0.25 ? "반반차" : `연차 ${dayText(x.leave_days)}일`}` : ""}</span>
                  {x.start_time && x.end_time && <small>{x.start_time} ~ {x.end_time}{x.night_hours > 0 ? ` · 야간 ${hoursText(x.night_hours)}시간` : ""}</small>}
                </div>
                <b>{x.hours > 0 ? `${hoursText(x.hours)}시간` : x.leave_days > 0 ? `${dayText(x.leave_days)}일` : ""}</b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
